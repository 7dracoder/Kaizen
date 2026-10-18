// What the coder gets to know before it writes a single line: decided by traversing the FalkorDB graph.
//
// Vector search alone answers "what text looks like this spec". The graph answers the questions that decide a board:
//   1. Which checks have boards for this spec failed before?           Spec ← Build ← Run → Check
//   2. Which lessons were learned from builds that failed those checks? Check ← Run → Build ← LEARNED_FROM Lesson
//   3. Which lessons were in context when this spec actually passed?    Spec ← Build ← Run{passed} → USED_LESSON Lesson
//   4. Which subcircuits did passing builds of this spec reuse?         Spec ← Build ← Run{passed} → REUSED Subcircuit
// Graph-backed picks come first (they have outcomes behind them); vector hits fill the rest of the budget
// (`config.context.lessons_k` / `subcircuits_k`). Every query, its row count and the reason each item was chosen are
// returned, stored on the run, and shown in the UI, so each decision can be traced to the graph path that caused it.
import type { HarnessConfig } from "@kaizen/types";
import { cypher } from "@kaizen/graph";
import { col, type StoredLesson, type StoredSubcircuit } from "../db.js";
import { retrieveLessons, retrieveSubcircuits } from "./memory.js";

type ContextPolicy = HarnessConfig["context"];

export interface GraphQueryLog {
  purpose: string;
  cypher: string;
  rows: number;
  ms: number;
}
export interface Pick {
  id: string;
  /** Why it was chosen: the graph path or the vector score. */
  why: string;
  via: "graph" | "vector";
}
export interface GraphContext {
  lessons: (StoredLesson & { score?: number })[];
  subcircuits: (StoredSubcircuit & { score?: number })[];
  /** The checks this spec's builds failed before (empty for a new spec). */
  riskyChecks: { check: string; times: number }[];
  picks: { lessons: Pick[]; subcircuits: Pick[] };
  queries: GraphQueryLog[];
}

const Q = {
  riskyChecks: `MATCH (:Spec {id: $spec})<-[:FOR_SPEC]-(:Build)<-[:OF_BUILD]-(r:Run)-[:FAILED_CHECK]->(k:Check)
RETURN k.name AS check, count(r) AS times ORDER BY times DESC LIMIT 6`,
  // A spec with no history borrows the failure profile of the agents' whole memory.
  riskyChecksGlobal: `MATCH (r:Run)-[:FAILED_CHECK]->(k:Check)
RETURN k.name AS check, count(r) AS times ORDER BY times DESC LIMIT 4`,
  lessonsForChecks: `MATCH (k:Check)<-[:FAILED_CHECK]-(:Run)-[:OF_BUILD]->(b:Build)<-[:LEARNED_FROM]-(l:Lesson)
WHERE k.name IN $checks AND l.active = true
RETURN l._id AS id, collect(DISTINCT k.name) AS checks, count(DISTINCT b) AS builds ORDER BY builds DESC LIMIT 10`,
  provenLessons: `MATCH (:Spec {id: $spec})<-[:FOR_SPEC]-(:Build)<-[:OF_BUILD]-(r:Run {passed: true})-[:USED_LESSON]->(l:Lesson)
WHERE l.active = true
RETURN l._id AS id, count(r) AS wins ORDER BY wins DESC LIMIT 10`,
  provenSubcircuits: `MATCH (:Spec {id: $spec})<-[:FOR_SPEC]-(:Build)<-[:OF_BUILD]-(r:Run {passed: true})-[:REUSED]->(s:Subcircuit)
RETURN s._id AS id, count(r) AS wins ORDER BY wins DESC LIMIT 5`,
};

export async function graphContext(spec: { _id: string; text: string }, policy: ContextPolicy): Promise<GraphContext> {
  const queries: GraphQueryLog[] = [];
  const run = async <T>(purpose: string, query: string, params: Record<string, unknown>) => {
    const t = Date.now();
    const rows = await cypher<T>(query, params, { readOnly: true });
    queries.push({ purpose, cypher: query, rows: rows.length, ms: Date.now() - t });
    return rows;
  };

  let risky = await run<{ check: string; times: number }>("Checks this spec failed before", Q.riskyChecks, { spec: spec._id });
  if (!risky.length) risky = await run<{ check: string; times: number }>("Checks failed most across all builds (new spec)", Q.riskyChecksGlobal, {});
  const checks = risky.map((r) => r.check);

  const [forChecks, proven, provenSubs, vectorLessons, vectorSubs] = await Promise.all([
    checks.length
      ? run<{ id: string; checks: string[]; builds: number }>("Lessons learned from builds that failed those checks", Q.lessonsForChecks, { checks })
      : Promise.resolve([]),
    run<{ id: string; wins: number }>("Lessons in context when this spec passed", Q.provenLessons, { spec: spec._id }),
    run<{ id: string; wins: number }>("Subcircuits reused by passing builds of this spec", Q.provenSubcircuits, { spec: spec._id }),
    retrieveLessons(spec.text, policy),
    retrieveSubcircuits(spec.text, policy),
  ]);
  queries.push({ purpose: "Vector search: lessons similar to the spec (FalkorDB vector index)", cypher: "CALL db.idx.vector.queryNodes('Lesson', 'embedding', k, vecf32($spec_embedding))", rows: vectorLessons.length, ms: 0 });
  queries.push({ purpose: "Vector search: subcircuits similar to the spec", cypher: "CALL db.idx.vector.queryNodes('Subcircuit', 'embedding', k, vecf32($spec_embedding))", rows: vectorSubs.length, ms: 0 });

  // Lessons: proven on this spec, then learned from the checks it tends to fail, then the closest by meaning.
  const lessonPicks: Pick[] = [];
  const add = (list: Pick[], p: Pick, cap: number) => {
    if (list.length < cap && !list.some((x) => x.id === p.id)) list.push(p);
  };
  const kL = policy.lessons_k;
  for (const p of proven) add(lessonPicks, { id: p.id, via: "graph", why: `in context for ${p.wins} passing attempt(s) of this spec` }, kL);
  for (const f of forChecks) add(lessonPicks, { id: f.id, via: "graph", why: `learned from ${f.builds} build(s) that failed ${f.checks.join(", ")}` }, kL);
  for (const v of vectorLessons) add(lessonPicks, { id: v._id, via: "vector", why: `similar to the spec (score ${v.score.toFixed(2)})` }, kL);

  const kS = policy.subcircuits_k;
  const subPicks: Pick[] = [];
  for (const p of provenSubs) add(subPicks, { id: p.id, via: "graph", why: `reused by ${p.wins} passing attempt(s) of this spec` }, kS);
  for (const v of vectorSubs) add(subPicks, { id: v._id, via: "vector", why: `similar to the spec (score ${v.score.toFixed(2)})` }, kS);

  const byId = <T extends { _id: string }>(rows: T[]) => new Map(rows.map((r) => [r._id, r]));
  const vl = byId(vectorLessons);
  const vs = byId(vectorSubs);
  const missingL = lessonPicks.filter((p) => !vl.has(p.id)).map((p) => p.id);
  const missingS = subPicks.filter((p) => !vs.has(p.id)).map((p) => p.id);
  const [moreL, moreS] = await Promise.all([
    missingL.length ? col.lessons.find({ _id: { $in: missingL } }, { projection: { embedding: 0 } }).toArray() : [],
    missingS.length ? col.subcircuits.find({ _id: { $in: missingS } }, { projection: { embedding: 0 } }).toArray() : [],
  ]);
  for (const l of moreL) vl.set(l._id, l as never);
  for (const s of moreS) vs.set(s._id, s as never);

  return {
    lessons: lessonPicks.map((p) => vl.get(p.id)).filter(Boolean) as GraphContext["lessons"],
    subcircuits: subPicks.map((p) => vs.get(p.id)).filter(Boolean) as GraphContext["subcircuits"],
    riskyChecks: risky,
    picks: { lessons: lessonPicks.filter((p) => vl.has(p.id)), subcircuits: subPicks.filter((p) => vs.has(p.id)) },
    queries,
  };
}

/** The coder's view of the risk profile: a short note added to the spec. */
export function riskNote(ctx: GraphContext): string {
  if (!ctx.riskyChecks.length) return "";
  return `\n\nFrom memory: builds like this most often failed these checks: ${ctx.riskyChecks.map((r) => `${r.check} (${r.times}x)`).join(", ")}. Make sure the design satisfies them.`;
}

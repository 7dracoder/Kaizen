// The Kaizen graph: node labels, indexes, and the relationships derived from each record.
//
//   (:Config)-[:CHILD_OF]->(:Config)              harness lineage (procedural memory)
//   (:Config)-[:HAS_RULE]->(:Rule)                rules the meta-agent added, shared by every config that keeps them
//   (:Run)-[:OF_BUILD]->(:Build)-[:FOR_SPEC]->(:Spec)
//   (:Run)-[:UNDER]->(:Config)                    which procedure produced this attempt
//   (:Run)-[:BY_AGENT]->(:Agent)                  planner / coder / critic / checker / meta (episodic memory)
//   (:Run)-[:FAILED_CHECK]->(:Check)              what went wrong, shared across every board that failed it
//   (:Run)-[:USED_LESSON]->(:Lesson)              semantic memory that was in the coder's context
//   (:Run)-[:REUSED]->(:Subcircuit)               library blocks reused in this attempt
//   (:Lesson)-[:LEARNED_FROM]->(:Build)           where a lesson came from
//   (:BoardVersion)-[:OF_BUILD]->(:Build)         each stored design of a build
//   (:WorkItem)-[:PART_OF]->(:Build), (:WorkItem)-[:DEPENDS_ON]->(:WorkItem)   the long-horizon plan
//   (:WorkItem)-[:CLAIMED_BY]->(:Worker)          live handoffs between worker processes
//   (:User)-[:REQUESTED]->(:Request)-[:PRODUCED]->(:Build)
//   (:User)-[:HAS_ACCOUNT]->(:Account), (:User)-[:HAS_SESSION]->(:Session)
//
// Build, Spec, Agent, Check, Rule and Worker are hub nodes merged on demand; every other label is a record
// (collection.ts). Edges are re-derived on each write, so they never drift from the records.
import { cypher, command, graphName } from "./client.js";
import { Collection, type Linker } from "./collection.js";

/** Which agent produced a run, from its stage (runs don't name their agent). */
export const STAGE_AGENT: Record<string, string> = {
  compile: "coder",
  checks: "checker",
  critique: "critic",
  improve_critique: "critic",
  improve: "coder",
  cache_hit: "library",
  subcircuit: "coder",
  final: "assembler",
  meta: "meta",
  plan: "planner",
  error: "worker",
};

const replaceEdges = async (label: string, id: string, rels: string[]) =>
  cypher(`MATCH (n:${label} {_id: $id})-[r]->() WHERE type(r) IN $rels DELETE r`, { id, rels });

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const linkRun: Linker = async (id, doc) => {
  await replaceEdges("Run", id, ["OF_BUILD", "UNDER", "BY_AGENT", "FAILED_CHECK", "USED_LESSON", "REUSED"]);
  const checks = Array.isArray(doc.failures)
    ? [...new Set((doc.failures as { check?: unknown }[]).map((f) => f?.check).filter((c): c is string => typeof c === "string"))]
    : [];
  await cypher(
    `MATCH (r:Run {_id: $id})
     MERGE (b:Build {id: $board}) MERGE (r)-[:OF_BUILD]->(b)
     MERGE (a:Agent {name: $agent}) MERGE (r)-[:BY_AGENT]->(a)
     FOREACH (c IN $checks | MERGE (k:Check {name: c}) MERGE (r)-[:FAILED_CHECK]->(k))
     FOREACH (s IN CASE WHEN $spec IS NULL THEN [] ELSE [$spec] END | MERGE (sp:Spec {id: s}) MERGE (b)-[:FOR_SPEC]->(sp))`,
    {
      id,
      board: String(doc.board_id ?? "unknown"),
      agent: STAGE_AGENT[String(doc.stage)] ?? String(doc.stage ?? "worker"),
      checks,
      spec: typeof doc.spec_id === "string" ? doc.spec_id : null,
    },
  );
  if (typeof doc.harness_version === "number")
    await cypher(`MATCH (r:Run {_id: $id}), (c:Config {version: $v}) MERGE (r)-[:UNDER]->(c)`, { id, v: doc.harness_version });
  const lessons = asList(doc.lessons_used);
  if (lessons.length)
    await cypher(`MATCH (r:Run {_id: $id}) UNWIND $ids AS lid MATCH (l:Lesson {_id: lid}) MERGE (r)-[:USED_LESSON]->(l)`, { id, ids: lessons });
  const subs = asList(doc.subcircuits_used);
  if (subs.length)
    await cypher(`MATCH (r:Run {_id: $id}) UNWIND $ids AS sid MATCH (s:Subcircuit {_id: sid}) MERGE (r)-[:REUSED]->(s)`, { id, ids: subs });
};

const linkConfig: Linker = async (id, doc) => {
  await replaceEdges("Config", id, ["CHILD_OF", "HAS_RULE"]);
  await cypher(
    `MATCH (c:Config {_id: $id})
     FOREACH (t IN $rules | MERGE (r:Rule {text: t}) MERGE (c)-[:HAS_RULE]->(r))`,
    { id, rules: asList(doc.rules) },
  );
  if (typeof doc.parent === "number")
    await cypher(`MATCH (c:Config {_id: $id}), (p:Config {version: $parent}) MERGE (c)-[:CHILD_OF]->(p)`, { id, parent: doc.parent });
};

const linkBoard: Linker = async (id, doc) => {
  await replaceEdges("BoardVersion", id, ["OF_BUILD"]);
  await cypher(
    `MATCH (v:BoardVersion {_id: $id}) MERGE (b:Build {id: $board}) MERGE (v)-[:OF_BUILD]->(b)
     FOREACH (s IN CASE WHEN $spec IS NULL THEN [] ELSE [$spec] END | MERGE (sp:Spec {id: s}) MERGE (b)-[:FOR_SPEC]->(sp))`,
    { id, board: String(doc.board_id ?? "unknown"), spec: typeof doc.spec_id === "string" ? doc.spec_id : null },
  );
};

const linkWorkItem: Linker = async (id, doc) => {
  await replaceEdges("WorkItem", id, ["PART_OF", "DEPENDS_ON", "CLAIMED_BY"]);
  await cypher(
    `MATCH (w:WorkItem {_id: $id}) MERGE (b:Build {id: $board}) MERGE (w)-[:PART_OF]->(b)
     WITH w UNWIND $deps AS d MATCH (x:WorkItem {_id: d}) MERGE (w)-[:DEPENDS_ON]->(x)`,
    { id, board: String(doc.board_id ?? "unknown"), deps: asList(doc.depends_on) },
  );
  if (doc.status === "running" && typeof doc.claimed_by === "string")
    await cypher(`MATCH (w:WorkItem {_id: $id}) MERGE (k:Worker {id: $worker}) MERGE (w)-[:CLAIMED_BY]->(k)`, { id, worker: doc.claimed_by });
};

const linkRequest: Linker = async (id, doc) => {
  await replaceEdges("Request", id, ["PRODUCED"]);
  if (typeof doc.user_id === "string")
    await cypher(`MATCH (q:Request {_id: $id}), (u:User {_id: $user}) MERGE (u)-[:REQUESTED]->(q)`, { id, user: doc.user_id });
  if (typeof doc.board_id === "string")
    await cypher(`MATCH (q:Request {_id: $id}) MERGE (b:Build {id: $board}) MERGE (q)-[:PRODUCED]->(b)`, { id, board: doc.board_id });
};

const linkToUser = (label: string, rel: string): Linker => async (id, doc) => {
  if (typeof doc.userId === "string")
    await cypher(`MATCH (x:${label} {_id: $id}), (u:User {_id: $user}) MERGE (u)-[:${rel}]->(x)`, { id, user: doc.userId });
};

/** Record collections by their historical names (the API routes and scripts use these). */
export const col = {
  harness: new Collection<Record<string, any>>("Config", linkConfig),
  specs: new Collection<Record<string, any>>("SpecRecord"),
  subcircuits: new Collection<Record<string, any>>("Subcircuit"),
  boards: new Collection<Record<string, any>>("BoardVersion", linkBoard),
  queue: new Collection<Record<string, any>>("WorkItem", linkWorkItem),
  runs: new Collection<Record<string, any>>("Run", linkRun),
  lessons: new Collection<Record<string, any>>("Lesson"),
  ablations: new Collection<Record<string, any>>("Ablation"),
  requests: new Collection<Record<string, any>>("Request", linkRequest),
  users: new Collection<Record<string, any>>("User"),
  accounts: new Collection<Record<string, any>>("Account", linkToUser("Account", "HAS_ACCOUNT")),
  sessions: new Collection<Record<string, any>>("Session", linkToUser("Session", "HAS_SESSION")),
  verificationTokens: new Collection<Record<string, any>>("VerificationToken"),
};

export type CollectionName = keyof typeof col;

/** Same collections by their storage names, for generic readers (health counts, the system view). */
export const COLLECTIONS: Record<string, Collection<Record<string, any>>> = {
  harness_versions: col.harness,
  specs: col.specs,
  subcircuits: col.subcircuits,
  boards: col.boards,
  work_queue: col.queue,
  runs: col.runs,
  lessons: col.lessons,
  ablations: col.ablations,
  spec_requests: col.requests,
  users: col.users,
  accounts: col.accounts,
  sessions: col.sessions,
  verification_tokens: col.verificationTokens,
};

export const collection = <T extends object = Record<string, any>>(name: string): Collection<T & Record<string, any>> => {
  const c = COLLECTIONS[name];
  if (!c) throw new Error(`unknown collection ${name}`);
  return c as unknown as Collection<T & Record<string, any>>;
};

/** Embedding size for the vector indexes. Voyage voyage-4 and the local fallback embedder both produce 1024. */
export const EMBEDDING_DIMS = Number(process.env.EMBEDDING_DIMS || 1024);

/**
 * Creates indexes, unique constraints and vector indexes. Safe to re-run (existing ones are skipped).
 * Called by `npm run setup` and at worker start.
 */
export async function ensureSchema(log: (m: string) => void = () => {}) {
  const tryRun = async (q: string) => {
    try {
      await cypher(q);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/already (indexed|exists)/i.test(msg)) log(`schema: ${msg}`);
    }
  };
  const labels = ["Config", "SpecRecord", "Subcircuit", "BoardVersion", "WorkItem", "Run", "Lesson", "Ablation", "Request", "User", "Account", "Session", "VerificationToken"];
  for (const l of labels) await tryRun(`CREATE INDEX FOR (n:${l}) ON (n._id)`);
  for (const [label, prop] of [
    ["Build", "id"], ["Spec", "id"], ["Agent", "name"], ["Check", "name"], ["Rule", "text"], ["Worker", "id"],
    ["Config", "version"], ["Config", "verdict"], ["Run", "board_id"], ["Run", "harness_version"], ["Run", "stage"],
    ["BoardVersion", "board_id"], ["WorkItem", "board_id"], ["WorkItem", "status"], ["Request", "status"],
    ["Request", "user_id"], ["Lesson", "active"], ["User", "email"], ["Account", "providerAccountId"], ["Session", "sessionToken"],
    ["VerificationToken", "identifier"],
  ] as const)
    await tryRun(`CREATE INDEX FOR (n:${label}) ON (n.${prop})`);
  for (const l of ["Lesson", "Subcircuit", "Run"])
    await tryRun(`CREATE VECTOR INDEX FOR (n:${l}) ON (n.embedding) OPTIONS {dimension: ${EMBEDDING_DIMS}, similarityFunction: 'cosine'}`);
  // Unique ids: two concurrent writers can never create the same record twice.
  for (const l of labels) {
    try {
      await command(["GRAPH.CONSTRAINT", "CREATE", graphName(), "UNIQUE", "NODE", l, "PROPERTIES", "1", "_id"]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/already exists/i.test(msg)) log(`constraint ${l}: ${msg}`);
    }
  }
  await tryRun(`CREATE INDEX FOR (n:Config) ON (n.version)`);
}

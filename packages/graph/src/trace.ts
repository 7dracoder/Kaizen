// Graph traversals that explain decisions: what shaped a build, and what the memory as a whole knows.
import { cypher } from "./client.js";

export interface TraceNode {
  id: string;
  type: string;
  label: string;
  detail?: Record<string, unknown>;
}
export interface TraceEdge {
  from: string;
  to: string;
  type: string;
}

const nodeId = (type: string, key: string) => `${type}:${key}`;

/**
 * The provenance of one build, as a small graph:
 *   Build ← Run (agent, stage, verdict) → Config → Rule
 *                                 Run → Lesson → (Build it was learned from)
 *                                 Run → Check (failed) ← other builds' runs that failed the same check
 */
export async function traceBuild(boardId: string): Promise<{ nodes: TraceNode[]; edges: TraceEdge[] }> {
  const nodes = new Map<string, TraceNode>();
  const edges: TraceEdge[] = [];
  const add = (n: TraceNode) => (nodes.has(n.id) ? nodes.get(n.id)! : (nodes.set(n.id, n), n));
  const link = (from: string, to: string, type: string) => {
    if (!edges.some((e) => e.from === from && e.to === to && e.type === type)) edges.push({ from, to, type });
  };
  const build = add({ id: nodeId("build", boardId), type: "build", label: boardId });

  const runs = await cypher<{ id: string; stage: string; passed: boolean; ts: string; agent: string | null; version: number | null }>(
    `MATCH (r:Run)-[:OF_BUILD]->(:Build {id: $b})
     OPTIONAL MATCH (r)-[:BY_AGENT]->(a:Agent)
     RETURN r._id AS id, r.stage AS stage, r.passed AS passed, r.ts AS ts, a.name AS agent, r.harness_version AS version
     ORDER BY r.ts ASC LIMIT 60`,
    { b: boardId },
    { readOnly: true },
  );
  for (const r of runs) {
    const id = nodeId("run", r.id);
    add({ id, type: "run", label: `${r.stage}${r.passed ? " ✓" : r.stage === "checks" || r.stage === "compile" ? " ✗" : ""}`, detail: { stage: r.stage, passed: r.passed, ts: r.ts, agent: r.agent } });
    link(id, build.id, "OF_BUILD");
    if (r.agent) {
      add({ id: nodeId("agent", r.agent), type: "agent", label: r.agent });
      link(id, nodeId("agent", r.agent), "BY_AGENT");
    }
  }

  const configs = await cypher<{ run: string; version: number; verdict: string; rules: string[] }>(
    `MATCH (r:Run)-[:OF_BUILD]->(:Build {id: $b}) MATCH (r)-[:UNDER]->(c:Config)
     OPTIONAL MATCH (c)-[:HAS_RULE]->(rule:Rule)
     RETURN r._id AS run, c.version AS version, c.verdict AS verdict, collect(DISTINCT rule.text) AS rules`,
    { b: boardId },
    { readOnly: true },
  );
  for (const c of configs) {
    const cid = nodeId("config", String(c.version));
    add({ id: cid, type: "config", label: `harness v${c.version}`, detail: { verdict: c.verdict } });
    link(nodeId("run", c.run), cid, "UNDER");
    for (const text of c.rules) {
      const rid = nodeId("rule", text);
      add({ id: rid, type: "rule", label: text });
      link(cid, rid, "HAS_RULE");
    }
  }

  const lessons = await cypher<{ run: string; id: string; pattern: string; helped: number; from: string | null }>(
    `MATCH (r:Run)-[:OF_BUILD]->(:Build {id: $b}) MATCH (r)-[:USED_LESSON]->(l:Lesson)
     OPTIONAL MATCH (l)-[:LEARNED_FROM]->(src:Build)
     RETURN r._id AS run, l._id AS id, l.pattern AS pattern, l.times_helped AS helped, src.id AS from`,
    { b: boardId },
    { readOnly: true },
  );
  for (const l of lessons) {
    const lid = nodeId("lesson", l.id);
    add({ id: lid, type: "lesson", label: l.pattern, detail: { times_helped: l.helped } });
    link(nodeId("run", l.run), lid, "USED_LESSON");
    if (l.from && l.from !== boardId) {
      add({ id: nodeId("build", l.from), type: "build", label: l.from });
      link(lid, nodeId("build", l.from), "LEARNED_FROM");
    }
  }

  const failed = await cypher<{ run: string; check: string; others: number }>(
    `MATCH (r:Run)-[:OF_BUILD]->(:Build {id: $b}) MATCH (r)-[:FAILED_CHECK]->(k:Check)
     OPTIONAL MATCH (o:Run)-[:FAILED_CHECK]->(k) WHERE NOT (o)-[:OF_BUILD]->(:Build {id: $b})
     RETURN r._id AS run, k.name AS check, count(DISTINCT o) AS others`,
    { b: boardId },
    { readOnly: true },
  );
  for (const f of failed) {
    const kid = nodeId("check", f.check);
    add({ id: kid, type: "check", label: f.check, detail: { failed_elsewhere: f.others } });
    link(nodeId("run", f.run), kid, "FAILED_CHECK");
  }

  const subs = await cypher<{ run: string; id: string; name: string }>(
    `MATCH (r:Run)-[:OF_BUILD]->(:Build {id: $b}) MATCH (r)-[:REUSED]->(s:Subcircuit)
     RETURN r._id AS run, s._id AS id, s.name AS name`,
    { b: boardId },
    { readOnly: true },
  );
  for (const s of subs) {
    const sid = nodeId("subcircuit", s.id);
    add({ id: sid, type: "subcircuit", label: s.name });
    link(nodeId("run", s.run), sid, "REUSED");
  }

  return { nodes: [...nodes.values()], edges };
}

/** What the shared memory holds, by node and relationship type, plus the lessons that earned their place. */
export async function memorySummary() {
  const [labels, rels, lessons, checks, lineage] = await Promise.all([
    cypher<{ label: string; n: number }>(`MATCH (n) RETURN labels(n)[0] AS label, count(n) AS n ORDER BY n DESC`, undefined, { readOnly: true }),
    cypher<{ type: string; n: number }>(`MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS n ORDER BY n DESC`, undefined, { readOnly: true }),
    // Multi-hop: a lesson's value is how many *passing* attempts had it in context.
    cypher<{ id: string; pattern: string; used: number; passed: number }>(
      `MATCH (l:Lesson) WHERE l.active = true
       OPTIONAL MATCH (r:Run)-[:USED_LESSON]->(l)
       RETURN l._id AS id, l.pattern AS pattern, count(r) AS used, sum(CASE WHEN r.passed THEN 1 ELSE 0 END) AS passed
       ORDER BY passed DESC, used DESC LIMIT 10`,
      undefined,
      { readOnly: true },
    ),
    cypher<{ check: string; builds: number }>(
      `MATCH (k:Check)<-[:FAILED_CHECK]-(:Run)-[:OF_BUILD]->(b:Build) RETURN k.name AS check, count(DISTINCT b) AS builds ORDER BY builds DESC LIMIT 10`,
      undefined,
      { readOnly: true },
    ),
    cypher<{ version: number; parent: number | null; verdict: string; rules: number }>(
      `MATCH (c:Config) OPTIONAL MATCH (c)-[:CHILD_OF]->(p:Config) OPTIONAL MATCH (c)-[:HAS_RULE]->(r:Rule)
       RETURN c.version AS version, p.version AS parent, c.verdict AS verdict, count(r) AS rules ORDER BY version`,
      undefined,
      { readOnly: true },
    ),
  ]);
  return { labels, relationships: rels, lessons, checks, lineage };
}

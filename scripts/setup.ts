// One-time (and safe to re-run) setup of the Kaizen graph in FalkorDB:
//   - indexes, unique-id constraints and vector indexes (Lesson, Subcircuit, Run)
//   - harness config v0
//   - the public spec list (specs/specs.json + specs/finale.json; never any hidden-check content)
//   - the agents as nodes, so runs and handoffs can point at them
//   npm run setup
import specs from "../specs/specs.json" with { type: "json" };
import finale from "../specs/finale.json" with { type: "json" };
import { cypher, graphName, falkorUrl } from "@kaizen/graph";
import { client, col, connect } from "../apps/worker/src/db.ts";
import { currentConfig, seedBaseline } from "../apps/worker/src/harness/config.ts";

await connect();
console.log(`FalkorDB ${falkorUrl()}, graph "${graphName()}": indexes, constraints and vector indexes ok`);

await seedBaseline();
console.log(`harness config: v${(await currentConfig()).version} is current`);

const all = [
  ...(specs as { _id: string; split: string; text: string }[]).map(({ _id, split, text }) => ({ _id, spec_id: _id, split, text })),
  { _id: finale._id, spec_id: finale._id, split: "finale", text: finale.text },
];
for (const s of all) await col.specs.replaceOne({ _id: s._id }, s, { upsert: true });
// The Spec hub node every build links to carries the public text too, so traversals can show what was asked.
await cypher(`UNWIND $specs AS s MERGE (sp:Spec {id: s._id}) SET sp.split = s.split, sp.text = s.text`, { specs: all });
console.log(`specs: ${all.length}`);

const agents = [
  ["planner", "Splits a spec into subcircuits and orders the work queue"],
  ["coder", "Writes tscircuit code for one board or work item"],
  ["checker", "Deterministic hidden checks, DRC and routing"],
  ["critic", "Diagnoses failures, proposes the smallest fix, writes lessons"],
  ["meta", "Proposes harness config changes from batch results"],
  ["assembler", "Combines finished subcircuits into one board"],
  ["library", "Serves a verified design from memory instead of redesigning"],
  ["memory", "Graph traversals that choose the coder's lessons and subcircuits"],
];
await cypher(`UNWIND $agents AS a MERGE (n:Agent {name: a[0]}) SET n.role = a[1]`, { agents });
await cypher(
  `MATCH (p:Agent {name: 'planner'}), (c:Agent {name: 'coder'}), (k:Agent {name: 'checker'}), (cr:Agent {name: 'critic'}), (m:Agent {name: 'meta'}), (a:Agent {name: 'assembler'})
   MERGE (p)-[:HANDS_OFF_TO]->(c) MERGE (c)-[:HANDS_OFF_TO]->(k) MERGE (k)-[:HANDS_OFF_TO]->(cr) MERGE (cr)-[:HANDS_OFF_TO]->(c)
   MERGE (k)-[:HANDS_OFF_TO]->(a) MERGE (k)-[:HANDS_OFF_TO]->(m) MERGE (m)-[:HANDS_OFF_TO]->(p)
   WITH c, cr MATCH (g:Agent {name: 'memory'}) MERGE (g)-[:HANDS_OFF_TO]->(c) MERGE (cr)-[:HANDS_OFF_TO]->(g)`,
);
console.log(`agents: ${agents.length}, with their handoff topology`);

await client.close();

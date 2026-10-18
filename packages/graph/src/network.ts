// The graph as nodes and links for the live network view: the neighbourhood of one build, or an overview of the
// whole memory. Straight from FalkorDB, so what's drawn is exactly what the agents read and write.
import { cypher } from "./client.js";

export interface NetNode {
  id: string;
  label: string;
  name: string;
  props: Record<string, unknown>;
}
export interface NetLink {
  source: string;
  target: string;
  type: string;
}
export interface Network {
  nodes: NetNode[];
  links: NetLink[];
  queries: { purpose: string; cypher: string; rows: number; ms: number }[];
}

type Raw = { id: number; labels: string[]; properties: Record<string, unknown> };

const HIDDEN = new Set(["_doc", "_keys", "_rev", "embedding", "email", "image", "sessionToken", "access_token", "refresh_token", "id_token"]);

function display(label: string, p: Record<string, unknown>): string {
  const s = (v: unknown, n = 42) => {
    const t = String(v ?? "");
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  switch (label) {
    case "Build": return s(p.id, 24);
    case "Run": return `${s(p.stage, 18)}${p.stage === "memory" ? "" : p.passed ? " ✓" : " ✗"}`;
    case "Agent": return s(p.name);
    case "Check": return s(p.name);
    case "Lesson": return s(p.pattern);
    case "Subcircuit": return s(p.name);
    case "Config": return `harness v${p.version}`;
    case "Rule": return s(p.text);
    case "Spec": return s(p.id);
    case "WorkItem": return s(p.title ?? p.key);
    case "Worker": return "worker";
    case "Request": return s(p.text ?? p.spec_id ?? "request", 32);
    case "BoardVersion": return `board ${s(p.kind ?? "", 12)}`;
    case "User": return "user";
    default: return label;
  }
}

function toNode(raw: Raw): NetNode {
  const label = raw.labels[0] ?? "Node";
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw.properties)) {
    if (HIDDEN.has(k)) continue;
    props[k] = typeof v === "string" && v.length > 240 ? `${v.slice(0, 239)}…` : v;
  }
  return { id: String(raw.id), label, name: display(label, raw.properties), props };
}

export async function network(opts: { boardId?: string; limit?: number } = {}): Promise<Network> {
  const nodes = new Map<string, NetNode>();
  const links: NetLink[] = [];
  const seen = new Set<string>();
  const queries: Network["queries"] = [];
  const run = async (purpose: string, q: string, params?: Record<string, unknown>) => {
    const t = Date.now();
    const rows = await cypher<{ a: Raw; t: string; b: Raw }>(q, params, { readOnly: true });
    queries.push({ purpose, cypher: q, rows: rows.length, ms: Date.now() - t });
    for (const r of rows) {
      if (!r.a || !r.b) continue;
      const a = toNode(r.a);
      const b = toNode(r.b);
      nodes.set(a.id, a);
      nodes.set(b.id, b);
      const key = `${a.id}|${r.t}|${b.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        links.push({ source: a.id, target: b.id, type: r.t });
      }
    }
  };
  const limit = Math.min(Math.max(opts.limit ?? 400, 10), 1500);

  if (opts.boardId) {
    const p = { b: opts.boardId };
    await run("Everything attached to the build", `MATCH (a)-[r]->(b:Build {id: $b}) RETURN a, type(r) AS t, b`, p);
    await run("The build's spec", `MATCH (a:Build {id: $b})-[r:FOR_SPEC]->(b) RETURN a, type(r) AS t, b`, p);
    await run(
      "What each run touched: agent, harness version, failed checks, lessons, subcircuits",
      `MATCH (:Build {id: $b})<-[:OF_BUILD]-(a:Run)-[r]->(b) WHERE NOT b:Build RETURN a, type(r) AS t, b`,
      p,
    );
    await run(
      "Where those lessons were learned",
      `MATCH (:Build {id: $b})<-[:OF_BUILD]-(:Run)-[:USED_LESSON]->(a:Lesson)-[r:LEARNED_FROM]->(b) RETURN a, type(r) AS t, b`,
      p,
    );
    await run(
      "Lessons this build taught",
      `MATCH (a:Lesson)-[r:LEARNED_FROM]->(b:Build {id: $b}) RETURN a, type(r) AS t, b`,
      p,
    );
    await run(
      "Harness lineage and rules",
      `MATCH (:Build {id: $b})<-[:OF_BUILD]-(:Run)-[:UNDER]->(a:Config)-[r:CHILD_OF|HAS_RULE]->(b) RETURN a, type(r) AS t, b`,
      p,
    );
    await run(
      "Work-queue dependencies",
      `MATCH (:Build {id: $b})<-[:PART_OF]-(a:WorkItem)-[r:DEPENDS_ON|CLAIMED_BY]->(b) RETURN a, type(r) AS t, b`,
      p,
    );
    await run(
      "Other builds that failed the same checks",
      `MATCH (:Build {id: $b})<-[:OF_BUILD]-(:Run)-[:FAILED_CHECK]->(k:Check)<-[:FAILED_CHECK]-(o:Run)-[r:OF_BUILD]->(ob:Build)
       WHERE ob.id <> $b WITH o AS a, r, ob AS b LIMIT 40 RETURN a, type(r) AS t, b`,
      p,
    );
  } else {
    await run(
      "The whole memory (accounts and raw spec records left out)",
      `MATCH (a)-[r]->(b)
       WHERE NOT a:Session AND NOT a:Account AND NOT a:SpecRecord AND NOT b:SpecRecord
       RETURN a, type(r) AS t, b LIMIT ${limit}`,
    );
  }
  return { nodes: [...nodes.values()], links, queries };
}

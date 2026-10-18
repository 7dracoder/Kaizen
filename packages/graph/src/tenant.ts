// Per-user memory: one isolated FalkorDB graph per signed-in user.
//
// Each graph holds that user's conversation with Kaizen as a chain of Episode nodes:
//   (:Episode {role: "user", text})-[:NEXT]->(:Episode {role: "kaizen", text, board_id, passed})-[:NEXT]->...
//   (:Episode)-[:ABOUT]->(:Build {id})
// It survives restarts and sessions, and no other user's queries can reach it: the shared graph never stores the
// prompt history, and each user graph is selected by a hash of the user id.
import { createHash } from "node:crypto";
import { cypher, listGraphs } from "./client.js";

export const tenantGraph = (userId: string) =>
  `kaizen_user_${createHash("sha256").update(userId).digest("hex").slice(0, 16)}`;

export interface Episode {
  id: string;
  role: "user" | "kaizen";
  text: string;
  at: string;
  request_id?: string;
  board_id?: string;
  passed?: boolean;
}

/** Appends one turn to the user's history, linked after their previous turn. */
export async function appendEpisode(userId: string, ep: Omit<Episode, "id" | "at"> & { at?: string }) {
  const g = tenantGraph(userId);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const props = {
    id,
    role: ep.role,
    text: ep.text.slice(0, 2000),
    at: ep.at ?? new Date().toISOString(),
    ...(ep.request_id && { request_id: ep.request_id }),
    ...(ep.board_id && { board_id: ep.board_id }),
    ...(typeof ep.passed === "boolean" && { passed: ep.passed }),
  };
  await cypher(
    `OPTIONAL MATCH (last:Episode) WHERE NOT (last)-[:NEXT]->()
     CREATE (e:Episode) SET e = $props
     FOREACH (l IN CASE WHEN last IS NULL THEN [] ELSE [last] END | CREATE (l)-[:NEXT]->(e))
     FOREACH (b IN CASE WHEN $board IS NULL THEN [] ELSE [$board] END | MERGE (x:Build {id: b}) MERGE (e)-[:ABOUT]->(x))`,
    { props, board: ep.board_id ?? null },
    { graph: g },
  );
  return id;
}

/** The user's most recent turns, newest first. Empty for a user with no history (the graph doesn't exist yet). */
export async function recentEpisodes(userId: string, limit = 20): Promise<Episode[]> {
  const g = tenantGraph(userId);
  if (!(await listGraphs()).includes(g)) return [];
  const rows = await cypher<{ p: Episode }>(
    `MATCH (e:Episode) RETURN properties(e) AS p ORDER BY e.at DESC LIMIT ${Math.floor(limit)}`,
    undefined,
    { graph: g, readOnly: true },
  );
  return rows.map((r) => r.p);
}

/** Wipes one user's memory graph (account deletion). */
export async function forgetUser(userId: string) {
  const g = tenantGraph(userId);
  if ((await listGraphs()).includes(g)) await cypher(`MATCH (n) DETACH DELETE n`, undefined, { graph: g });
}

// Vector search over record nodes (FalkorDB vector indexes, cosine).
import { cypher } from "./client.js";
import { fromNode, type Filter } from "./collection.js";

/**
 * Nearest records to `vector` among nodes with `label` whose `embedder` matches (vectors from different embedding
 * models are never compared). `where` filters on scalar properties (equality only).
 *
 * `score` is normalized to 0..1 like other vector stores report cosine similarity: (1 + cos) / 2.
 * FalkorDB returns cosine *distance* (1 - cos), so score = 1 - distance / 2.
 */
export async function vectorSearch<T = Record<string, unknown>>(
  label: string,
  vector: number[],
  k: number,
  opts: { embedder: string; where?: Filter },
): Promise<(T & { _id: string; score: number })[]> {
  if (k <= 0) return [];
  const conds = Object.keys(opts.where ?? {}).map((key, i) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`bad filter field ${key}`);
    return `node.${key} = $w${i}`;
  });
  const params: Record<string, unknown> = { v: vector, k: Math.max(k * 5, 50), embedder: opts.embedder };
  Object.values(opts.where ?? {}).forEach((v, i) => (params[`w${i}`] = v));
  const rows = await cypher<{ p: Record<string, unknown>; d: number }>(
    `CALL db.idx.vector.queryNodes('${label}', 'embedding', $k, vecf32($v)) YIELD node, score
     WITH node, score WHERE node._doc IS NOT NULL AND node.embedder = $embedder${conds.length ? ` AND ${conds.join(" AND ")}` : ""}
     RETURN properties(node) AS p, score AS d ORDER BY d ASC LIMIT ${Math.floor(k)}`,
    params,
    { readOnly: true },
  );
  return rows.map((r) => ({ ...fromNode<T>(r.p), score: 1 - r.d / 2 }));
}

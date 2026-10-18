// Long-term memory in FalkorDB: embeddings + FalkorDB vector indexes + optional Voyage rerank.
// Lessons and verified subcircuits are the semantic memory; failed runs are the episodic memory.
// How much comes back (k, rerank on/off) is set by the harness config, so the meta-agent can tune it.
//
// Embeddings come from Voyage when VOYAGE_API_KEY is set. Without it, a local hashing embedder (no network, no cost,
// lower recall) keeps memory working; each vector records which embedder made it, and searches only compare vectors
// from the same embedder, so switching providers never mixes incompatible vectors.
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { HarnessConfig, Lesson } from "@kaizen/types";
import { cypher, vectorSearch as graphVectorSearch } from "@kaizen/graph";
import { col, type StoredLesson, type StoredSubcircuit } from "../db.js";

type Document = object;

type ContextPolicy = HarnessConfig["context"];

const VOYAGE = "https://api.voyageai.com/v1";
const CANDIDATES = 20; // vector hits handed to the reranker before trimming to k

async function voyage(path: string, body: unknown): Promise<any> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY is not set");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${VOYAGE}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    // Rate limited (parallel ablation runs, or an account without a payment method): back off and retry.
    if (res.status === 429 && attempt < 4) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 5_000 * 2 ** attempt));
      continue;
    }
    throw new Error(`voyage ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** Embeds short descriptions (not raw code). Use "query" for search text, "document" for stored text. */
export async function embed(texts: string[], inputType: "document" | "query"): Promise<number[][]> {
  if (!process.env.VOYAGE_API_KEY) return texts.map(localEmbedding);
  const json = await voyage("embeddings", {
    input: texts,
    model: process.env.VOYAGE_MODEL || "voyage-4",
    input_type: inputType,
  });
  return json.data.map((d: { embedding: number[] }) => d.embedding);
}

/** Which embedder made the vectors this process writes and searches. */
export const embedderId = () => (process.env.VOYAGE_API_KEY ? `voyage:${process.env.VOYAGE_MODEL || "voyage-4"}` : "local-hash-v1");

const DIMS = Number(process.env.EMBEDDING_DIMS || 1024);

/**
 * Free offline fallback: feature-hashed word unigrams and bigrams, L2-normalized. Finds lessons that share wording
 * ("I2C pull-up", "decoupling cap") but not paraphrases; set VOYAGE_API_KEY for semantic recall.
 */
export function localEmbedding(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  const words = text.toLowerCase().replace(/[^a-z0-9.+-]+/g, " ").split(" ").filter((w) => w.length > 1);
  const add = (token: string, weight: number) => {
    const h = createHash("md5").update(token).digest();
    const i = h.readUInt32LE(0) % DIMS;
    v[i] += (h[4] & 1 ? 1 : -1) * weight;
  };
  words.forEach((w, i) => {
    add(w, 1);
    if (i > 0) add(`${words[i - 1]} ${w}`, 0.7);
  });
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

/** Indices of `documents`, best first, as judged by the reranker. Without a Voyage key, the vector order stands. */
export async function rerank(query: string, documents: string[], topK: number): Promise<number[]> {
  if (!documents.length) return [];
  if (!process.env.VOYAGE_API_KEY) return documents.slice(0, topK).map((_, i) => i);
  const json = await voyage("rerank", {
    query,
    documents,
    model: process.env.VOYAGE_RERANK_MODEL || "rerank-2.5",
    top_k: topK,
  });
  return json.data.map((d: { index: number }) => d.index);
}

async function vectorSearch<T extends Document>(
  label: "Lesson" | "Subcircuit" | "Run",
  queryVector: number[],
  limit: number,
  filter?: Record<string, unknown>,
): Promise<(T & { score: number })[]> {
  return (await graphVectorSearch<T>(label, queryVector, limit, { embedder: embedderId(), where: filter })) as (T & { score: number })[];
}

/** Vector search for CANDIDATES hits, then rerank (if the policy says so) and keep the top k. */
async function retrieve<T extends Document>(
  query: string,
  k: number,
  policy: ContextPolicy,
  search: (vector: number[], limit: number) => Promise<(T & { score: number })[]>,
  textOf: (hit: T) => string,
): Promise<(T & { score: number })[]> {
  if (k <= 0) return [];
  const [vector] = await embed([query], "query");
  const hits = await search(vector, policy.rerank ? Math.max(k, CANDIDATES) : k);
  if (!policy.rerank || hits.length <= 1) return hits.slice(0, k);
  const order = await rerank(query, hits.map(textOf), k);
  return order.map((i) => hits[i]);
}

const lessonText = (l: Pick<Lesson, "pattern" | "fix">) => `${l.pattern}. Fix: ${l.fix}`;
const hashId = (prefix: string, text: string) =>
  `${prefix}_${createHash("sha1").update(text.trim().toLowerCase()).digest("hex").slice(0, 12)}`;

// ---- lessons (learned design rules) ----

// Vector-search score (cosine, normalized to 0..1) at or above which a new lesson counts as a restatement of an existing
// one. Measured on the first 12 critic lessons: restated pull-up lessons scored 0.978, while genuinely different I2C lessons
// (address pins, bus wiring) scored 0.93–0.955, so this stays conservative.
const DUPLICATE_SCORE = 0.965;

/**
 * Stores a lesson. The same pattern always maps to the same id, so re-learning it updates instead of duplicating;
 * a new pattern that restates an existing active lesson (score ≥ DUPLICATE_SCORE) returns that lesson's id instead.
 */
export async function addLesson(lesson: { pattern: string; fix: string }, source?: { boardId?: string }): Promise<string> {
  // A lesson retired in review stays retired: re-learning it, or a near-duplicate of it, returns its id
  // unchanged. `npm run lessons -- restore <id>` is the only way back.
  const _id = hashId("lesson", lesson.pattern);
  const [embedding] = await embed([lessonText(lesson)], "document");
  const embedder = embedderId();
  const existing = await col.lessons.findOne({ _id }, { projection: { active: 1 } });
  if (existing) {
    if (existing.active === false) return _id;
    await col.lessons.updateOne({ _id }, { $set: { pattern: lesson.pattern, fix: lesson.fix, embedding, embedder } });
    await linkLessonSource(_id, source?.boardId);
    return _id;
  }
  const [near] = await vectorSearch<StoredLesson>("Lesson", embedding, 1);
  if (near && near.score >= DUPLICATE_SCORE) {
    await linkLessonSource(near._id, source?.boardId);
    return near._id;
  }
  await col.lessons.insertOne({ _id, pattern: lesson.pattern, fix: lesson.fix, embedding, embedder, active: true, times_helped: 0, created_at: new Date() } as StoredLesson & { embedder: string });
  await linkLessonSource(_id, source?.boardId);
  return _id;
}

/** (Lesson)-[:LEARNED_FROM]->(Build): which build taught it, so a trace can follow a lesson back to its origin. */
async function linkLessonSource(lessonId: string, boardId?: string) {
  if (!boardId) return;
  await cypher(`MATCH (l:Lesson {_id: $l}) MERGE (b:Build {id: $b}) MERGE (l)-[:LEARNED_FROM]->(b)`, { l: lessonId, b: boardId });
}

/** The lessons most relevant to a spec or failure summary, up to `context.lessons_k`. */
export async function retrieveLessons(query: string, policy: ContextPolicy) {
  return retrieve<StoredLesson>(
    query,
    policy.lessons_k,
    policy,
    (v, limit) => vectorSearch<StoredLesson>("Lesson", v, limit, { active: true }),
    lessonText,
  );
}

/** Credit lessons that were in context when a board passed; the meta-agent can see which ones earn their place. */
export async function markLessonsHelped(ids: string[]) {
  if (ids.length) await col.lessons.updateMany({ _id: { $in: ids } }, { $inc: { times_helped: 1 } });
}

// ---- subcircuits (verified building blocks) ----

/** Saves a verified subcircuit. `description` is what gets embedded, so write it the way a spec would ask for it. */
export async function addSubcircuit(sub: {
  name: string;
  description: string;
  code: string;
  checks_passed: string[];
}): Promise<string> {
  const _id = hashId("sub", sub.name);
  const [embedding] = await embed([sub.description], "document");
  await col.subcircuits.updateOne(
    { _id },
    { $set: { ...sub, embedding, embedder: embedderId() }, $setOnInsert: { reuse_count: 0, created_at: new Date() } },
    { upsert: true },
  );
  return _id;
}

/** Library subcircuits worth reusing for this spec, up to `context.subcircuits_k`. */
export async function retrieveSubcircuits(query: string, policy: ContextPolicy) {
  return retrieve<StoredSubcircuit>(
    query,
    policy.subcircuits_k,
    policy,
    (v, limit) => vectorSearch<StoredSubcircuit>("Subcircuit", v, limit),
    (s) => s.description,
  );
}

export async function markSubcircuitsReused(ids: string[]) {
  if (ids.length) await col.subcircuits.updateMany({ _id: { $in: ids } }, { $inc: { reuse_count: 1 } });
}

// ---- failed runs (episodic memory) ----

/** Attaches a searchable summary to a failed run so later failures can find it. */
export async function indexFailure(runId: string, summary: string) {
  const [embedding] = await embed([summary], "document");
  await col.runs.updateOne({ _id: runId }, { $set: { failure_summary: summary, embedding, embedder: embedderId() } });
}

/** Past failed runs that look like this one, e.g. to show the critic how a similar failure was fixed. */
export async function similarFailures(summary: string, k: number, policy: ContextPolicy) {
  return retrieve<Document & { failure_summary?: string }>(
    summary,
    k,
    policy,
    (v, limit) => vectorSearch("Run", v, limit, { passed: false }),
    (r) => r.failure_summary ?? "",
  );
}

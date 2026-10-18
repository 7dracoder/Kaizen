// Document records stored as FalkorDB nodes.
//
// Each record is one node with a label (Run, Lesson, Config, ...). Top-level scalar fields and lists of scalars are
// node properties, so Cypher can filter, sort, index and traverse on them; nested objects (failures, metrics,
// Circuit JSON) are kept together in one JSON property, `_doc`. `_rev` increments on every write and makes
// read-modify-write updates safe under concurrency (compare-and-set, retried).
//
// The query surface (find/findOne/updateOne/...) is deliberately small: just what the harness needs. Relationship
// maintenance lives in schema.ts (`linkers`): every write re-derives the node's edges, so the graph — run → config,
// run → lessons used, work item → dependencies, user → request → build — is always in step with the records.
import { randomBytes } from "node:crypto";
import { cypher, type Params } from "./client.js";

export type Filter = Record<string, unknown>;
export type Sort = Record<string, 1 | -1>;
export type Projection = Record<string, 0 | 1>;
export interface FindOptions {
  sort?: Sort;
  limit?: number;
  projection?: Projection;
}
export interface Update {
  $set?: object;
  $unset?: Record<string, unknown>;
  $inc?: Record<string, number>;
  $setOnInsert?: object;
  $push?: Record<string, unknown>;
  $pull?: Record<string, unknown>;
}

export class DuplicateKeyError extends Error {
  code = 11000;
}

/** Called after a node is written so its edges match its fields. */
export type Linker = (id: string, doc: Record<string, unknown>) => Promise<void>;

const INTERNAL = new Set(["_id", "_doc", "_rev", "_keys", "embedding", "embedder"]);
const SAFE_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const newId = () => randomBytes(12).toString("hex");

const isScalar = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const isScalarList = (v: unknown) =>
  Array.isArray(v) && v.every(isScalar) && (v.length === 0 || v.every((x) => typeof x === typeof v[0]));

/** Dates become ISO strings everywhere, so sorting by time works on strings and nothing depends on driver types. */
function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = normalize(v);
    return out;
  }
  return value;
}

/** Splits a record into node properties (scalars, scalar lists) and the JSON blob (everything nested). */
function toNode(id: string, doc: Record<string, unknown>, rev: number) {
  const props: Record<string, unknown> = { _id: id, _rev: rev };
  const nested: Record<string, unknown> = {};
  const keys: string[] = [];
  let embedding: number[] | undefined;
  for (const [k, raw] of Object.entries(normalize(doc) as Record<string, unknown>)) {
    if (k === "_id" || raw === undefined) continue;
    if (k === "embedding") {
      if (Array.isArray(raw) && raw.length) embedding = raw as number[];
      continue;
    }
    if (!SAFE_FIELD.test(k)) throw new Error(`field name not supported: ${k}`);
    keys.push(k);
    if (k === "embedder" && typeof raw === "string") props.embedder = raw;
    else if (isScalar(raw) || isScalarList(raw)) props[k] = raw;
    else nested[k] = raw; // objects, lists of objects, null
  }
  props._keys = keys;
  props._doc = JSON.stringify(nested);
  return { props, embedding };
}

/** Node properties back into the record shape callers expect (`_id`, nested fields restored). */
export function fromNode<T = Record<string, unknown>>(props: Record<string, unknown>): T & { _id: string } {
  const nested = typeof props._doc === "string" ? (JSON.parse(props._doc) as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { _id: props._id, ...nested };
  for (const [k, v] of Object.entries(props)) if (!INTERNAL.has(k) || k === "embedder") out[k] = v;
  return out as T & { _id: string };
}

// ---- filters → Cypher WHERE ----

function compileFilter(filter: Filter, params: Params, prefix = "n"): string {
  const parts: string[] = [];
  let i = Object.keys(params).length;
  const p = (v: unknown) => {
    const name = `p${i++}`;
    params[name] = normalize(v);
    return `$${name}`;
  };
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "$or" || key === "$and") {
      const subs = (cond as Filter[]).map((f) => `(${compileFilter(f, params, prefix) || "true"})`);
      i = Object.keys(params).length;
      parts.push(`(${subs.join(key === "$or" ? " OR " : " AND ") || "true"})`);
      continue;
    }
    if (!SAFE_FIELD.test(key)) throw new Error(`filter on nested field not supported: ${key}`);
    const field = `${prefix}.${key}`;
    if (cond && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date)) {
      for (const [op, v] of Object.entries(cond as Record<string, unknown>)) {
        switch (op) {
          case "$in": parts.push(`${field} IN ${p(v)}`); break;
          case "$nin": parts.push(`NOT coalesce(${field} IN ${p(v)}, false)`); break;
          case "$ne": parts.push(`(${field} IS NULL OR ${field} <> ${p(v)})`); break;
          case "$lt": parts.push(`${field} < ${p(v)}`); break;
          case "$lte": parts.push(`${field} <= ${p(v)}`); break;
          case "$gt": parts.push(`${field} > ${p(v)}`); break;
          case "$gte": parts.push(`${field} >= ${p(v)}`); break;
          case "$exists": parts.push(v ? `'${key}' IN ${prefix}._keys` : `NOT '${key}' IN ${prefix}._keys`); break;
          default: throw new Error(`filter operator not supported: ${op}`);
        }
      }
    } else if (cond === null) {
      parts.push(`NOT '${key}' IN ${prefix}._keys`);
    } else {
      parts.push(`${field} = ${p(cond)}`);
    }
  }
  return parts.join(" AND ");
}

function project<T extends Record<string, unknown>>(doc: T, projection?: Projection): T {
  if (!projection || !Object.keys(projection).length) return doc;
  const include = Object.entries(projection).filter(([, v]) => v === 1).map(([k]) => k);
  if (include.length) {
    const out: Record<string, unknown> = { _id: doc._id };
    for (const k of include) if (k in doc) out[k] = doc[k];
    return out as T;
  }
  const out = { ...doc } as Record<string, unknown>;
  for (const [k, v] of Object.entries(projection)) if (v === 0) delete out[k];
  return out as T;
}

// ---- updates, applied in JS on a fresh copy ----

function applyUpdate(doc: Record<string, unknown>, update: Update, inserting: boolean) {
  const out = { ...doc };
  if (inserting) Object.assign(out, update.$setOnInsert ?? {});
  for (const [k, v] of Object.entries((update.$set ?? {}) as Record<string, unknown>)) out[k] = v;
  for (const k of Object.keys(update.$unset ?? {})) delete out[k];
  for (const [k, v] of Object.entries(update.$inc ?? {})) out[k] = (Number(out[k]) || 0) + v;
  for (const [k, v] of Object.entries(update.$push ?? {})) out[k] = [...((out[k] as unknown[]) ?? []), v];
  for (const [k, v] of Object.entries(update.$pull ?? {})) out[k] = ((out[k] as unknown[]) ?? []).filter((x) => x !== v);
  return out;
}

const isUpdate = (u: object): boolean => Object.keys(u).some((k) => k.startsWith("$"));

export class Cursor<T> implements AsyncIterable<T> {
  constructor(private run: (opts: FindOptions) => Promise<T[]>, private opts: FindOptions = {}) {}
  sort(sort: Sort) { this.opts.sort = sort; return this; }
  limit(limit: number) { this.opts.limit = limit; return this; }
  project(projection: Projection) { this.opts.projection = projection; return this; }
  toArray(): Promise<T[]> { return this.run(this.opts); }
  async next(): Promise<T | null> { return (await this.run({ ...this.opts, limit: 1 }))[0] ?? null; }
  async *[Symbol.asyncIterator]() { for (const d of await this.toArray()) yield d; }
}

/** A labelled set of record nodes. `T` is the record shape; `_id` is always a string. */
export class Collection<T extends object = Record<string, unknown>> {
  constructor(readonly label: string, private linker?: Linker) {}

  private async write(id: string, doc: Record<string, unknown>, rev: number, expectRev: number | null) {
    const { props, embedding } = toNode(id, doc, rev);
    const params: Params = { id, props, ...(embedding && { emb: embedding }) };
    const setEmb = embedding ? ", n.embedding = vecf32($emb)" : "";
    let rows: { n: number }[];
    if (expectRev === null) {
      // Insert: MERGE on _id so a duplicate key is detected instead of creating a second node.
      rows = await cypher<{ n: number }>(
        `MERGE (n:${this.label} {_id: $id}) ON CREATE SET n = $props${setEmb}, n._new = true
         WITH n, n._new AS created SET n._new = null RETURN CASE WHEN created THEN 1 ELSE 0 END AS n`,
        params,
      );
    } else {
      params.rev = expectRev;
      rows = await cypher<{ n: number }>(
        // Reads never return the vector, so an update without a new one keeps the stored embedding.
        `MATCH (n:${this.label} {_id: $id}) WHERE n._rev = $rev
         WITH n, n.embedding AS kept SET n = $props SET n.embedding = ${embedding ? "vecf32($emb)" : "kept"} RETURN count(n) AS n`,
        params,
      );
    }
    const ok = (rows[0]?.n ?? 0) === 1;
    if (ok && this.linker) await this.linker(id, { _id: id, ...(normalize(doc) as object) });
    return ok;
  }

  private async raw(filter: Filter, opts: FindOptions = {}): Promise<(T & { _id: string })[]> {
    const params: Params = {};
    const where = compileFilter(filter, params);
    const order = Object.entries(opts.sort ?? {})
      .map(([k, dir]) => {
        if (!SAFE_FIELD.test(k)) throw new Error(`sort field not supported: ${k}`);
        return `n.${k} ${dir === -1 ? "DESC" : "ASC"}`;
      })
      .join(", ");
    const rows = await cypher<{ p: Record<string, unknown> }>(
      `MATCH (n:${this.label}) WHERE n._doc IS NOT NULL${where ? ` AND ${where}` : ""}
       RETURN properties(n) AS p${order ? ` ORDER BY ${order}` : ""}${opts.limit ? ` LIMIT ${Math.floor(opts.limit)}` : ""}`,
      params,
      { readOnly: true },
    );
    return rows.map((r) => fromNode<T>(r.p));
  }

  find(filter: Filter = {}, opts: FindOptions = {}): Cursor<T & { _id: string }> {
    return new Cursor(async (o) => (await this.raw(filter, o)).map((d) => project(d, o.projection)), { ...opts });
  }

  async findOne(filter: Filter = {}, opts: Omit<FindOptions, "limit"> = {}): Promise<(T & { _id: string }) | null> {
    const [doc] = await this.raw(filter, { ...opts, limit: 1 });
    return doc ? project(doc, opts.projection) : null;
  }

  async countDocuments(filter: Filter = {}, _opts?: unknown): Promise<number> {
    const params: Params = {};
    const where = compileFilter(filter, params);
    const [row] = await cypher<{ c: number }>(
      `MATCH (n:${this.label}) WHERE n._doc IS NOT NULL${where ? ` AND ${where}` : ""} RETURN count(n) AS c`,
      params,
      { readOnly: true },
    );
    return row?.c ?? 0;
  }

  estimatedDocumentCount() {
    return this.countDocuments();
  }

  async insertOne(doc: object): Promise<{ insertedId: string }> {
    const d = doc as Record<string, unknown>;
    const id = typeof d._id === "string" ? d._id : d._id != null ? String(d._id) : newId();
    if (!(await this.write(id, d, 1, null))) throw new DuplicateKeyError(`duplicate key ${this.label} ${id}`);
    return { insertedId: id };
  }

  async insertMany(docs: object[]) {
    const ids: string[] = [];
    for (const d of docs) ids.push((await this.insertOne(d)).insertedId);
    return { insertedCount: ids.length, insertedIds: ids };
  }

  /** Read, change, compare-and-set; retried when another writer got there first. */
  private async modifyOne(
    filter: Filter,
    change: (doc: Record<string, unknown> | null, inserting: boolean) => Record<string, unknown> | null,
    opts: { upsert?: boolean; sort?: Sort } = {},
  ): Promise<{ matched: number; before: (T & { _id: string }) | null; after: Record<string, unknown> | null; upsertedId?: string }> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const [current] = await this.rawWithRev(filter, opts.sort);
      if (!current) {
        if (!opts.upsert) return { matched: 0, before: null, after: null };
        const seed: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(filter)) if (!k.startsWith("$") && (v === null || typeof v !== "object")) seed[k] = v;
        const next = change(seed, true);
        if (!next) return { matched: 0, before: null, after: null };
        const id = typeof next._id === "string" ? next._id : typeof seed._id === "string" ? seed._id : newId();
        if (await this.write(id, { ...next, _id: id }, 1, null)) return { matched: 0, before: null, after: next, upsertedId: id };
        continue; // someone inserted it meanwhile: update that one instead
      }
      const next = change(current.doc, false);
      if (!next) return { matched: 1, before: current.doc as T & { _id: string }, after: null };
      if (await this.write(current.doc._id as string, next, current.rev + 1, current.rev))
        return { matched: 1, before: current.doc as T & { _id: string }, after: next };
    }
    throw new Error(`${this.label}: too much write contention`);
  }

  private async rawWithRev(filter: Filter, sort?: Sort) {
    const params: Params = {};
    const where = compileFilter(filter, params);
    const order = Object.entries(sort ?? {}).map(([k, d]) => `n.${k} ${d === -1 ? "DESC" : "ASC"}`).join(", ");
    const rows = await cypher<{ p: Record<string, unknown> }>(
      `MATCH (n:${this.label}) WHERE n._doc IS NOT NULL${where ? ` AND ${where}` : ""}
       RETURN properties(n) AS p${order ? ` ORDER BY ${order}` : ""} LIMIT 1`,
      params,
    );
    return rows.map((r) => ({ doc: fromNode(r.p) as Record<string, unknown>, rev: Number(r.p._rev) || 0 }));
  }

  async updateOne(filter: Filter, update: Update, opts: { upsert?: boolean } = {}) {
    const r = await this.modifyOne(filter, (doc, inserting) => applyUpdate(doc ?? {}, update, inserting), opts);
    return { matchedCount: r.matched, modifiedCount: r.after && r.matched ? 1 : 0, upsertedId: r.upsertedId ?? null };
  }

  async replaceOne(filter: Filter, replacement: object, opts: { upsert?: boolean } = {}) {
    if (isUpdate(replacement)) throw new Error("replaceOne takes a full document, not an update");
    const r = await this.modifyOne(
      filter,
      (doc) => ({ ...(replacement as Record<string, unknown>), _id: (doc?._id as string | undefined) ?? (filter._id as string | undefined) }),
      opts,
    );
    return { matchedCount: r.matched, modifiedCount: r.matched, upsertedId: r.upsertedId ?? null };
  }

  async findOneAndUpdate(
    filter: Filter,
    update: Update,
    opts: { sort?: Sort; upsert?: boolean; returnDocument?: "before" | "after" } = {},
  ): Promise<(T & { _id: string }) | null> {
    const r = await this.modifyOne(filter, (doc, inserting) => applyUpdate(doc ?? {}, update, inserting), opts);
    if (opts.returnDocument === "after") return (r.after as (T & { _id: string }) | null) ?? null;
    return r.before;
  }

  async updateMany(filter: Filter, update: Update) {
    const ids = (await this.raw(filter)).map((d) => d._id);
    let modified = 0;
    for (const _id of ids) {
      const r = await this.updateOne({ ...filter, _id }, update);
      modified += r.modifiedCount;
    }
    return { matchedCount: ids.length, modifiedCount: modified };
  }

  async deleteMany(filter: Filter = {}) {
    const params: Params = {};
    const where = compileFilter(filter, params);
    const [row] = await cypher<{ c: number }>(
      `MATCH (n:${this.label}) WHERE n._doc IS NOT NULL${where ? ` AND ${where}` : ""}
       WITH n, 1 AS one DETACH DELETE n RETURN sum(one) AS c`,
      params,
    );
    return { deletedCount: row?.c ?? 0 };
  }

  async deleteOne(filter: Filter) {
    const doc = await this.findOne(filter, { projection: { _id: 1 } });
    if (!doc) return { deletedCount: 0 };
    return this.deleteMany({ _id: doc._id });
  }
}


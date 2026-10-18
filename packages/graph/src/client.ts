// FalkorDB connection shared by the worker, the scripts and the web app.
//
// One FalkorDB instance holds several graphs:
//   - FALKORDB_GRAPH (default "kaizen"): the shared memory and coordination graph — harness config lineage,
//     the lesson and subcircuit library, every run and board, the work queue, spec requests and accounts.
//   - "kaizen_user_<hash>": one isolated graph per signed-in user for their own conversation history
//     (see tenant.ts). FalkorDB keeps graphs fully separate inside one instance.
//
// The client is cached on globalThis so Next.js hot reloads and long-running workers reuse one connection.
import { FalkorDB, type Graph } from "falkordb";

const cache = globalThis as unknown as { _kaizenFalkor?: Promise<FalkorDB> };

export const graphName = () => process.env.FALKORDB_GRAPH || "kaizen";
export const falkorUrl = () => process.env.FALKORDB_URL || "redis://127.0.0.1:6379";

/** The connection, opened on first use. Fails fast (5 s) instead of hanging when FalkorDB isn't running. */
export function falkor(): Promise<FalkorDB> {
  cache._kaizenFalkor ??= FalkorDB.connect({
    url: falkorUrl(),
    socket: { connectTimeout: 5_000, reconnectStrategy: (retries: number) => (retries > 3 ? false : 500) },
  } as never).catch((err) => {
    cache._kaizenFalkor = undefined; // let the next call retry instead of caching the failure
    throw new Error(`FalkorDB is not reachable at ${falkorUrl()} (${err instanceof Error ? err.message : err}). Start it with \`npm run db\`.`);
  });
  return cache._kaizenFalkor;
}

export async function graph(name = graphName()): Promise<Graph> {
  return (await falkor()).selectGraph(name);
}

export type Params = Record<string, unknown>;

/** Runs a Cypher query on a graph and returns its rows. Every FalkorDB query is atomic. */
export async function cypher<T = Record<string, unknown>>(
  query: string,
  params?: Params,
  opts: { graph?: string; readOnly?: boolean } = {},
): Promise<T[]> {
  const g = await graph(opts.graph);
  const options = params ? { params: params as never } : undefined;
  try {
    const reply = opts.readOnly ? await g.roQuery<T>(query, options) : await g.query<T>(query, options);
    return (reply.data ?? []) as T[];
  } catch (err) {
    // A graph that has never been written doesn't exist yet: reading it is just empty.
    if (opts.readOnly && err instanceof Error && /empty key/i.test(err.message)) return [];
    throw err;
  }
}

/** A raw Redis command on the FalkorDB connection (pub/sub, constraints, INFO). */
export async function command(args: string[]): Promise<unknown> {
  const conn = (await (await falkor()).connection) as unknown as { sendCommand(a: string[]): Promise<unknown> };
  return conn.sendCommand(args);
}

/** Publishes a wake-up on a channel; the worker subscribes so new requests start at once (no polling delay). */
export async function publish(channel: string, message: string) {
  const conn = (await (await falkor()).connection) as unknown as { publish(c: string, m: string): Promise<number> };
  return conn.publish(channel, message);
}

/** Subscribes on a dedicated connection. Returns an unsubscribe function. */
export async function subscribe(channel: string, onMessage: (message: string) => void): Promise<() => Promise<void>> {
  const conn = (await (await falkor()).connection) as unknown as {
    duplicate(): { connect(): Promise<unknown>; subscribe(c: string, cb: (m: string) => void): Promise<void>; quit(): Promise<unknown>; on(e: string, cb: (e: Error) => void): void };
  };
  const sub = conn.duplicate();
  sub.on("error", () => {}); // a dropped subscriber falls back to the caller's poll
  await sub.connect();
  await sub.subscribe(channel, onMessage);
  return async () => {
    await sub.quit().catch(() => {});
  };
}

export async function ping(): Promise<number> {
  const t = Date.now();
  await cypher("RETURN 1", undefined, { readOnly: true });
  return Date.now() - t;
}

export async function close() {
  const pending = cache._kaizenFalkor;
  cache._kaizenFalkor = undefined;
  if (pending) await (await pending.catch(() => null))?.close().catch(() => {});
}

/** Every graph in the instance (the shared graph plus one per user). */
export async function listGraphs(): Promise<string[]> {
  return (await falkor()).list();
}

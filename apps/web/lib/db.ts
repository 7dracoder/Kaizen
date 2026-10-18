// FalkorDB access for the web app (server-side only).
//
// Rules:
//   - Read design state; never write it. The worker is the single writer of runs, boards, configs, memory and the
//     queue. The web app's only writes are spec requests (lib/requests.ts) and accounts (lib/auth-adapter.ts).
//   - Import this from route handlers or server components, never from a client component.
//
// The connection is cached on globalThis inside @kaizen/graph, so dev hot reloads reuse it.

import { collection, falkorUrl, graphName } from "@kaizen/graph";

export const db = () => ({ collection, databaseName: graphName() });

/** True when the app has a FalkorDB to talk to. Locally it defaults to redis://127.0.0.1:6379. */
export const graphConfigured = (): boolean => Boolean(falkorUrl());

/** Embeddings are 1024 floats per record and never belong in a response. */
export const NO_EMBEDDING = { embedding: 0 } as const;

/**
 * Wraps a query so a database problem renders as a degraded panel rather than
 * a 500 that takes the page down mid-demo.
 */
export async function readGraph<T>(
  run: () => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await run() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "query failed" };
  }
}

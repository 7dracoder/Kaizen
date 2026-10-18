// Spec requests from the web app.
// The web app writes only Request nodes (and accounts). This worker side claims requests atomically, runs them, and
// writes status back, so "one writer" still holds for all design state.
// New requests wake the worker through FalkorDB pub/sub (channel REQUESTS_CHANNEL); a slow poll backs it up.
import { setTimeout as sleep } from "node:timers/promises";
import { appendEpisode, cypher, fromNode, subscribe } from "@kaizen/graph";
import { col, type SpecRequest } from "../db.js";
import { hostname } from "node:os";
import { defaultWorkerId, releaseAbandoned } from "./queue.js";

const HEARTBEAT_MS = 5_000;
const STALE_MS = 60_000;
const POLL_MS = 10_000;
const now = () => new Date().toISOString();
export const REQUESTS_CHANNEL = "kaizen:requests";

export type RequestHandler = (
  req: SpecRequest & { _id: NonNullable<SpecRequest["_id"]> },
  setBoard: (boardId: string, harnessVersion: number) => Promise<void>,
) => Promise<{ passed: boolean; attempts?: number }>;

/** Requests this worker was running when it died, and anyone's whose heartbeat went stale, go back to queued. */
export async function recoverRequests(workerId = defaultWorkerId()) {
  void workerId; // ownership is decided by host + pid (see queue.ts abandoned)
  const running = await col.requests.find({ status: "running" }, { projection: { claimed_host: 1, claimed_pid: 1, heartbeat: 1 } }).toArray();
  return releaseAbandoned("Request", running.map((r) => ({ ...r, _id: r._id! })), STALE_MS, "queued");
}

/** Atomically claims the oldest queued request (one Cypher query; FalkorDB serializes writes). */
export async function claimRequest(workerId = defaultWorkerId()): Promise<SpecRequest | null> {
  const t = now();
  const [row] = await cypher<{ p: Record<string, unknown> }>(
    `MATCH (q:Request) WHERE q.status = 'queued'
     WITH q ORDER BY q.created_at ASC LIMIT 1
     SET q.status = 'running', q.claimed_by = $worker, q.claimed_pid = $pid, q.claimed_host = $host,
         q.started_at = $t, q.heartbeat = $t, q._rev = q._rev + 1
     RETURN properties(q) AS p`,
    { worker: workerId, pid: process.pid, host: hostname(), t },
  );
  return row ? (fromNode(row.p) as unknown as SpecRequest) : null;
}

/** Records the outcome in the requesting user's own memory graph (their persistent conversation history). */
async function remember(req: SpecRequest, outcome: { passed?: boolean; error?: string }) {
  if (!req.user_id) return;
  const latest = await col.requests.findOne({ _id: req._id });
  const board = latest?.board_id;
  const text = outcome.error
    ? `Build failed: ${outcome.error.slice(0, 300)}`
    : outcome.passed
      ? `Built ${board ?? "the board"}: passed every check.`
      : `Built ${board ?? "the board"}: did not pass every check.`;
  await appendEpisode(req.user_id, { role: "kaizen", text, request_id: String(req._id), board_id: board, passed: outcome.passed }).catch(() => {});
}

async function runOne(req: SpecRequest & { _id: NonNullable<SpecRequest["_id"]> }, handler: RequestHandler, workerId: string) {
  const mine = { _id: req._id, status: "running" as const, claimed_by: workerId, claimed_pid: process.pid };
  const beat = setInterval(
    () =>
      void cypher(
        `MATCH (q:Request {_id: $id}) WHERE q.status = 'running' AND q.claimed_by = $worker AND q.claimed_pid = $pid SET q.heartbeat = $t`,
        { id: String(req._id), worker: workerId, pid: process.pid, t: now() },
      ).catch(() => {}),
    HEARTBEAT_MS,
  );
  try {
    const setBoard = async (board_id: string, harness_version: number) => {
      await col.requests.updateOne(mine, { $set: { board_id, harness_version } });
    };
    const { passed, attempts } = await handler(req, setBoard);
    await col.requests.updateOne(mine, { $set: { status: "done", passed, attempts, finished_at: now() }, $unset: { claimed_by: "", claimed_pid: "", claimed_host: "" } });
    await remember(req, { passed });
    return passed;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await col.requests.updateOne(mine, { $set: { status: "failed", error: error.slice(0, 500), finished_at: now() }, $unset: { claimed_by: "", claimed_pid: "", claimed_host: "" } });
    await remember(req, { error });
    throw err;
  } finally {
    clearInterval(beat);
  }
}

/**
 * Serves spec requests until `signal` aborts: recovers interrupted ones, then runs up to `concurrency` requests
 * at once (each a separate board, so different users' prompts progress in parallel), waiting on a pub/sub wake-up
 * for new inserts (with a slow poll as backup) whenever there's spare capacity and nothing queued.
 *
 * `concurrency` lanes share one `workerId`/pid/host for claim bookkeeping — that's fine: `claimed_pid`/`claimed_host`
 * exist to tell "this process is alive" from "this process died," not to tell lanes apart, and each lane's writes
 * are scoped to its own request `_id` (see `runOne`), so lanes never contend with each other.
 */
export async function serveRequests(
  handler: RequestHandler,
  opts: { workerId?: string; log?: (m: string) => void; signal?: AbortSignal; concurrency?: number } = {},
) {
  const workerId = opts.workerId ?? defaultWorkerId();
  const log = opts.log ?? (() => {});
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const recovered = await recoverRequests(workerId);
  if (recovered) log(`recovered ${recovered} interrupted request(s)`);

  // Every idle lane registers a resolver here; a change-stream insert (or abort) wakes all of them at once, not
  // just whichever lane happened to register last (a single shared `wake` variable would starve every other lane).
  let waiters: (() => void)[] = [];
  const wakeAll = () => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };
  const unsubscribe = await subscribe(REQUESTS_CHANNEL, wakeAll).catch((e) => {
    log(`pub/sub unavailable (falling back to polling): ${e instanceof Error ? e.message : e}`);
    return async () => {};
  });
  opts.signal?.addEventListener("abort", wakeAll);

  const lane = async (id: number) => {
    while (!opts.signal?.aborted) {
      const req = await claimRequest(workerId);
      if (!req) {
        await Promise.race([new Promise<void>((r) => waiters.push(r)), sleep(POLL_MS)]);
        await recoverRequests(workerId);
        continue;
      }
      const what = req.spec_id ?? `"${(req.text ?? "").slice(0, 60)}"`;
      const tag = concurrency > 1 ? `[lane ${id}] ` : "";
      log(`${tag}request ${req._id}: ${what}`);
      try {
        const passed = await runOne(req as SpecRequest & { _id: NonNullable<SpecRequest["_id"]> }, handler, workerId);
        log(`${tag}request ${req._id}: ${passed ? "passed" : "done, did not pass"}`);
      } catch (err) {
        log(`${tag}request ${req._id}: failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, (_, i) => lane(i)));
  } finally {
    await unsubscribe();
  }
}

// Durable work queue for long-horizon boards, stored as a dependency graph in FalkorDB:
//   (:WorkItem)-[:PART_OF]->(:Build), (:WorkItem)-[:DEPENDS_ON]->(:WorkItem), (:WorkItem)-[:CLAIMED_BY]->(:Worker)
// Three rules make "kill it, restart it, nothing lost" true:
//   1. Claims and status changes are single Cypher queries, and FalkorDB runs each query atomically, so two workers
//      can never claim the same step and a lost claim can never be completed.
//   2. Writes are idempotent: a step's run and board ids are derived from board, step and attempt, written with upsert,
//      and they're written *before* the step is marked done.
//   3. Workers resume from the queue: a restarted worker reclaims its own unfinished items at once, anyone's item whose
//      heartbeat has gone stale is put back as pending, and dependents of finished steps are always unblocked.
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { RunResult } from "@kaizen/types";
import { cypher, fromNode } from "@kaizen/graph";
import { col, type StoredWorkItem } from "../db.js";

type Document = Record<string, unknown>;

const HEARTBEAT_MS = 5_000;
const STALE_MS = 30_000;

/** Stable per machine, so a restarted worker recognizes the items it was running when it died. */
export const defaultWorkerId = () => process.env.WORKER_ID || `worker-${hostname()}`;

/** True if `pid` is a running process on this machine (signal 0 only checks). */
export function processAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

type Claim = { _id: string | object; claimed_host?: string; claimed_pid?: number; heartbeat?: string };

/**
 * A live pid on this host whose claim hasn't heartbeat in this long is a reused pid (the claimer died, e.g. across a
 * reboot, and an unrelated process got its number). Far above any event-loop stall (a long autoroute), which is why the
 * same-host check trusts the pid over `staleMs` in the first place.
 */
const REUSED_PID_MS = 10 * 60_000;

/**
 * Whether a running claim is abandoned: claimed on this host by a process that no longer exists (a restart resumes at
 * once) or whose pid was reused (heartbeat older than REUSED_PID_MS), or claimed on another host with a heartbeat older
 * than `staleMs`. The pid is only trusted on the host that wrote it, so a shared WORKER_ID across machines can't make a
 * dead claim look alive (or a live one dead).
 */
export function abandoned(item: Omit<Claim, "_id">, staleMs: number) {
  const staleFor = (ms: number) => !item.heartbeat || Date.parse(item.heartbeat) < Date.now() - ms;
  if (item.claimed_host === hostname()) {
    if (item.claimed_pid === process.pid) return false;
    return !processAlive(item.claimed_pid) || staleFor(REUSED_PID_MS);
  }
  return staleFor(staleMs);
}

/**
 * Re-queues abandoned claims. Each write matches the exact claim that was judged (pid and heartbeat), so if its owner
 * heartbeats or finishes between the read and the write, nothing is stolen.
 */
export async function releaseAbandoned(
  label: "WorkItem" | "Request",
  claims: Claim[],
  staleMs: number,
  back: "pending" | "queued",
) {
  let released = 0;
  for (const c of claims.filter((c) => abandoned(c, staleMs))) {
    const [row] = await cypher<{ n: number }>(
      `MATCH (n:${label} {_id: $id})
       WHERE n.status = 'running' AND coalesce(n.claimed_pid, -1) = $pid AND coalesce(n.heartbeat, '') = $hb
       SET n.status = $back, n.claimed_by = null, n.claimed_pid = null, n.claimed_host = null, n._rev = n._rev + 1
       RETURN count(n) AS n`,
      { id: String(c._id), pid: c.claimed_pid ?? -1, hb: c.heartbeat ?? "", back },
    );
    released += row?.n ?? 0;
  }
  return released;
}

export const runId = (boardId: string, step: number, attempt: number) =>
  createHash("sha1").update(`${boardId}:${step}:${attempt}`).digest("hex");

const itemId = (boardId: string, key: string) => `${boardId}:${key}`;
const now = () => new Date().toISOString();

export interface NewItem {
  key: string;
  title: string;
  depends_on?: string[]; // keys of other items on the same board
  payload?: Record<string, unknown>;
  max_attempts?: number;
}

/** Adds a board's steps (the planner's split). Re-enqueuing the same keys is a no-op, so a crashed planner can rerun. */
export async function enqueue(boardId: string, items: NewItem[]) {
  const keys = new Set(items.map((i) => i.key));
  for (const i of items) {
    for (const d of i.depends_on ?? []) if (!keys.has(d)) throw new Error(`${i.key} depends on unknown item ${d}`);
  }
  for (const [step, item] of items.entries()) {
    const deps = (item.depends_on ?? []).map((d) => itemId(boardId, d));
    await col.queue.updateOne(
      { _id: itemId(boardId, item.key) },
      {
        $setOnInsert: {
          board_id: boardId,
          key: item.key,
          step,
          title: item.title,
          payload: item.payload,
          status: "pending" as const,
          depends_on: deps,
          waiting_on: deps,
          attempts: 0,
          max_attempts: item.max_attempts ?? 3,
        },
      },
      { upsert: true },
    );
  }
  // Dependencies may be enqueued after their dependents: re-derive the DEPENDS_ON edges now that every item exists.
  await cypher(
    `MATCH (w:WorkItem {board_id: $b}) UNWIND w.depends_on AS d MATCH (x:WorkItem {_id: d}) MERGE (w)-[:DEPENDS_ON]->(x)`,
    { b: boardId },
  );
}

/** Removes finished dependencies from every item's `waiting_on`. Idempotent; run after each completion and on recovery. */
export async function unblock(boardId: string) {
  await cypher(
    `MATCH (w:WorkItem {board_id: $b}) WHERE size(w.waiting_on) > 0
     OPTIONAL MATCH (d:WorkItem) WHERE d._id IN w.waiting_on AND d.status = 'done'
     WITH w, collect(d._id) AS done
     WHERE size(done) > 0
     SET w.waiting_on = [x IN w.waiting_on WHERE NOT x IN done], w._rev = w._rev + 1`,
    { b: boardId },
  );
}

/**
 * Puts interrupted items back as pending: this worker's own running items (it restarted),
 * plus anyone's whose heartbeat is older than STALE_MS (that worker died).
 */
export async function recover(workerId = defaultWorkerId(), boardId?: string) {
  void workerId; // kept in the signature for callers; ownership is decided by host + pid (see abandoned)
  const running = await col.queue
    .find({ status: "running", ...(boardId && { board_id: boardId }) }, { projection: { claimed_host: 1, claimed_pid: 1, heartbeat: 1 } })
    .toArray();
  if (boardId) await unblock(boardId);
  return releaseAbandoned("WorkItem", running, STALE_MS, "pending");
}

/** Atomically claims the next ready item (pending, no unfinished dependencies), lowest step first. */
export async function claimNext(workerId = defaultWorkerId(), boardId?: string): Promise<StoredWorkItem | null> {
  const t = now();
  // One query: pick the lowest ready step and claim it. FalkorDB serializes writes, so no other worker can take it.
  const [row] = await cypher<{ p: Record<string, unknown> }>(
    `MATCH (w:WorkItem) WHERE w.status = 'pending' AND size(w.waiting_on) = 0${boardId ? " AND w.board_id = $b" : ""}
     WITH w ORDER BY w.step ASC LIMIT 1
     SET w.status = 'running', w.claimed_by = $worker, w.claimed_pid = $pid, w.claimed_host = $host,
         w.heartbeat = $t, w.started_at = $t, w.attempts = w.attempts + 1, w._rev = w._rev + 1
     MERGE (k:Worker {id: $worker}) MERGE (w)-[:CLAIMED_BY]->(k)
     RETURN properties(w) AS p`,
    { b: boardId ?? null, worker: workerId, pid: process.pid, host: hostname(), t },
  );
  return row ? (fromNode(row.p) as unknown as StoredWorkItem) : null;
}

/** Refreshes the heartbeat. Returns false if the claim was lost (the item was recovered and taken by another worker). */
export async function heartbeat(item: StoredWorkItem, workerId = defaultWorkerId()) {
  const [row] = await cypher<{ n: number }>(
    `MATCH (w:WorkItem {_id: $id}) WHERE w.status = 'running' AND w.claimed_by = $worker AND w.claimed_pid = $pid
     SET w.heartbeat = $t RETURN count(w) AS n`,
    { id: item._id, worker: workerId, pid: process.pid, t: now() },
  );
  return (row?.n ?? 0) === 1;
}

class LostClaim extends Error {}

/** Atomically moves a claimed item out of `running`; false if this worker no longer holds the claim. */
async function release(item: StoredWorkItem, workerId: string, status: "done" | "pending" | "failed", error?: string) {
  const [row] = await cypher<{ n: number }>(
    `MATCH (w:WorkItem {_id: $id}) WHERE w.status = 'running' AND w.claimed_by = $worker AND w.claimed_pid = $pid
     SET w.status = $status, w.finished_at = $t, w.error = $error,
         w.claimed_by = null, w.claimed_pid = null, w.claimed_host = null, w._rev = w._rev + 1
     WITH w OPTIONAL MATCH (w)-[c:CLAIMED_BY]->() DELETE c
     RETURN count(DISTINCT w) AS n`,
    { id: item._id, worker: workerId, pid: process.pid, status, t: now(), error: error ?? null },
  );
  return (row?.n ?? 0) === 1;
}

/** Throws unless this worker still holds the claim (the item wasn't recovered and taken by someone else). */
async function stillMine(item: StoredWorkItem, workerId: string) {
  const [row] = await cypher<{ n: number }>(
    `MATCH (w:WorkItem {_id: $id}) WHERE w.status = 'running' AND w.claimed_by = $worker AND w.claimed_pid = $pid RETURN count(w) AS n`,
    { id: item._id, worker: workerId, pid: process.pid },
  );
  if ((row?.n ?? 0) !== 1) throw new LostClaim(`lost claim on ${item._id}`);
}

/**
 * Finishes a step: upserts its run and board version (ids derived from board, step and attempt, so a retry overwrites
 * instead of duplicating), then atomically marks the item done and unblocks its dependents.
 * Throws if this worker no longer holds the claim.
 */
export async function complete(
  item: StoredWorkItem,
  result: { run: RunResult; board?: Document },
  workerId = defaultWorkerId(),
) {
  await stillMine(item, workerId);
  const _id = runId(item.board_id, item.step, item.attempts);
  await col.runs.replaceOne({ _id }, result.run as never, { upsert: true });
  if (result.board) await col.boards.replaceOne({ _id: `${_id}_board` }, { ...result.board } as never, { upsert: true });
  if (!(await release(item, workerId, "done"))) throw new LostClaim(`lost claim on ${item._id}`);
  await unblock(item.board_id);
}

/** Records a failed attempt. Retries (back to pending) until max_attempts, then marks the item failed. */
export async function fail(item: StoredWorkItem, error: string, run?: RunResult, workerId = defaultWorkerId()) {
  await stillMine(item, workerId);
  if (run) await col.runs.replaceOne({ _id: runId(item.board_id, item.step, item.attempts) }, run as never, { upsert: true });
  const retry = item.attempts < item.max_attempts;
  if (!(await release(item, workerId, retry ? "pending" : "failed", error))) throw new LostClaim(`lost claim on ${item._id}`);
}

/** Counts by status, plus the items in each state, for the UI and the demo. */
export async function progress(boardId: string) {
  const items = (await col.queue.find({ board_id: boardId }, { sort: { step: 1 } }).toArray()) as StoredWorkItem[];
  const counts = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const i of items) counts[i.status]++;
  return { ...counts, total: items.length, items };
}

export type Handler = (item: StoredWorkItem) => Promise<{ run: RunResult; board?: Document }>;

/**
 * Runs a board's queue to the end with one worker: recover, then claim → handle (with heartbeats) → complete.
 * Kill it at any point and call it again; it picks up where it stopped.
 */
export async function runQueue(
  boardId: string,
  handler: Handler,
  opts: { workerId?: string; log?: (msg: string) => void } = {},
) {
  const workerId = opts.workerId ?? defaultWorkerId();
  const log = opts.log ?? (() => {});
  const recovered = await recover(workerId, boardId);
  if (recovered) log(`recovered ${recovered} interrupted item(s)`);

  for (;;) {
    const item = await claimNext(workerId, boardId);
    if (!item) {
      const p = await progress(boardId);
      // Nothing running and nothing claimable: finished, or the rest is blocked behind a failed item.
      if (p.running === 0) return p;
      await sleep(1_000); // another worker is still running something this board needs
      await recover(workerId, boardId);
      continue;
    }
    log(`claimed ${item.key} (attempt ${item.attempts}/${item.max_attempts})`);
    const beat = setInterval(() => void heartbeat(item, workerId).catch(() => {}), HEARTBEAT_MS);
    try {
      const result = await handler(item);
      await complete(item, result, workerId);
      log(`done ${item.key}`);
    } catch (err) {
      try {
        if (err instanceof LostClaim) throw err;
        const message = err instanceof Error ? err.message : String(err);
        await fail(item, message, undefined, workerId);
        log(`failed ${item.key}: ${message}`);
      } catch (e) {
        if (!(e instanceof LostClaim)) throw e;
        log(e.message); // another worker recovered and took this item; leave it to them
      }
    } finally {
      clearInterval(beat);
    }
  }
}

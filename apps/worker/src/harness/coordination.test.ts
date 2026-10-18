// Coordination on FalkorDB: the work queue under concurrent workers, spec-request claims, and memory with the local
// embedder. Needs a running FalkorDB (`npm run db`); uses its own graph and deletes it. Run: npm run test:graph
process.env.FALKORDB_GRAPH = `kaizen_test_coord_${process.pid}`;
delete process.env.VOYAGE_API_KEY; // always the free local embedder here

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const graph = await import("@kaizen/graph");
const { connect, col, close } = await import("../db.ts");
const queue = await import("./queue.ts");
const requests = await import("./requests.ts");
const memory = await import("./memory.ts");
const { BASELINE } = await import("./config.ts");
const { graphContext } = await import("./graph-context.ts");

let reachable = true;
before(async () => {
  try {
    await connect();
  } catch {
    reachable = false;
  }
});
after(async () => {
  if (reachable) await (await graph.graph()).delete().catch(() => {});
  await close();
});
const live = (name: string, fn: () => Promise<void>) =>
  test(name, async (t) => {
    if (!reachable) return t.skip("FalkorDB not running (npm run db)");
    await fn();
  });

const run = (board: string) => ({ board_id: board, harness_version: 0, stage: "subcircuit", passed: true, failures: [], drc_errors: 0, ts: new Date().toISOString() });

describe("work queue", () => {
  live("dependencies gate claims, and finishing a step unblocks its dependents", async () => {
    await queue.enqueue("q1", [
      { key: "a", title: "A" },
      { key: "b", title: "B", depends_on: ["a"] },
      { key: "c", title: "C", depends_on: ["a", "b"] },
    ]);
    const first = await queue.claimNext("w1", "q1");
    assert.equal(first?.key, "a");
    assert.equal(await queue.claimNext("w1", "q1"), null, "b and c wait on a");
    await queue.complete(first!, { run: run("q1") }, "w1");
    const second = await queue.claimNext("w1", "q1");
    assert.equal(second?.key, "b");
    await queue.complete(second!, { run: run("q1") }, "w1");
    assert.equal((await queue.claimNext("w1", "q1"))?.key, "c");
    const edges = await graph.cypher<{ n: number }>(`MATCH (:WorkItem {board_id: 'q1'})-[r:DEPENDS_ON]->() RETURN count(r) AS n`);
    assert.equal(edges[0].n, 3);
  });

  live("twelve concurrent claimers never take the same step twice", async () => {
    await queue.enqueue("q2", Array.from({ length: 6 }, (_, i) => ({ key: `s${i}`, title: `S${i}` })));
    const claims = await Promise.all(Array.from({ length: 12 }, (_, i) => queue.claimNext(`w${i}`, "q2")));
    const keys = claims.filter(Boolean).map((c) => c!.key);
    assert.equal(keys.length, 6);
    assert.equal(new Set(keys).size, 6);
  });

  live("a lost claim can't be completed", async () => {
    await queue.enqueue("q3", [{ key: "x", title: "X" }]);
    const item = (await queue.claimNext("w1", "q3"))!;
    await graph.cypher(`MATCH (w:WorkItem {_id: $id}) SET w.claimed_by = 'someone-else'`, { id: item._id });
    await assert.rejects(queue.complete(item, { run: run("q3") }, "w1"), /lost claim/);
  });

  live("runQueue finishes a board end to end, idempotently", async () => {
    await queue.enqueue("q4", [{ key: "p", title: "P" }, { key: "q", title: "Q", depends_on: ["p"] }]);
    const p = await queue.runQueue("q4", async () => ({ run: run("q4"), board: { board_id: "q4", kind: "subcircuit" } }));
    assert.equal(p.done, 2);
    assert.equal(await col.runs.countDocuments({ board_id: "q4" }), 2);
    assert.equal(await col.boards.countDocuments({ board_id: "q4" }), 2);
  });
});

describe("spec requests", () => {
  live("concurrent workers claim each request once, oldest first", async () => {
    for (let i = 0; i < 3; i++) await col.requests.insertOne({ text: `board ${i}`, status: "queued", created_at: `2026-10-18T10:00:0${i}Z` });
    const claimed = await Promise.all(Array.from({ length: 6 }, (_, i) => requests.claimRequest(`w${i}`)));
    const got = claimed.filter(Boolean).map((r) => r!.text);
    assert.equal(got.length, 3);
    assert.equal(new Set(got).size, 3);
  });
});

describe("memory (local embedder)", () => {
  live("lessons are stored, deduplicated, retrieved, and linked to their build", async () => {
    const policy = { ...BASELINE.context, rerank: false };
    const id = await memory.addLesson({ pattern: "I2C SDA and SCL lines need pull-up resistors to VCC", fix: "Add 4.7k pull-ups" }, { boardId: "b-i2c" });
    const again = await memory.addLesson({ pattern: "I2C SDA and SCL lines need pull-up resistors to VCC", fix: "Add 4.7k pull-ups to 3V3" });
    assert.equal(again, id);
    await memory.addLesson({ pattern: "Every IC power pin needs a 100nF decoupling capacitor", fix: "Place a cap near VDD" });
    const hits = await memory.retrieveLessons("sensor on I2C bus, SDA SCL floating, no pull-up", policy);
    assert.equal(hits[0]?._id, id);
    const [src] = await graph.cypher<{ b: string }>(`MATCH (:Lesson {_id: $id})-[:LEARNED_FROM]->(b:Build) RETURN b.id AS b`, { id });
    assert.equal(src?.b, "b-i2c");
  });
});

describe("graph-driven context", () => {
  live("a new spec gets the lessons learned from builds that failed the checks it is likely to fail", async () => {
    const policy = { ...BASELINE.context, rerank: false, lessons_k: 3 };
    await col.harness.updateOne({ _id: "v0" }, { $setOnInsert: BASELINE }, { upsert: true });
    // An earlier build failed `decoupling`, and the critic learned a lesson from it.
    await col.runs.replaceOne(
      { _id: "old_1" },
      { board_id: "old-build", spec_id: "t07", harness_version: 0, stage: "checks", passed: false, failures: [{ check: "decoupling", detail: "U1 VDD has no cap" }], drc_errors: 0, ts: new Date().toISOString() },
      { upsert: true },
    );
    const lesson = await memory.addLesson({ pattern: "Every microcontroller VDD pin needs its own 100nF capacitor", fix: "Place C next to each VDD" }, { boardId: "old-build" });
    // A brand-new spec with no history of its own, worded nothing like the lesson.
    const ctx = await graphContext({ _id: "adhoc-new", text: "A blinking light for a bike" }, policy);
    assert.ok(ctx.riskyChecks.some((r) => r.check === "decoupling"));
    const pick = ctx.picks.lessons.find((p) => p.id === lesson);
    assert.equal(pick?.via, "graph");
    assert.match(pick!.why, /decoupling/);
    assert.equal(ctx.lessons[0]?._id, lesson);
    assert.ok(ctx.queries.some((q) => q.purpose.startsWith("Lessons learned from builds") && q.rows >= 1));
  });
});

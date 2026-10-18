// Integration tests for the FalkorDB store. Needs a running FalkorDB (`npm run db`); uses its own graph
// (kaizen_test_<pid>) and deletes it afterwards, so it never touches real data. Run: npm run test:graph
process.env.FALKORDB_GRAPH = `kaizen_test_${process.pid}`;

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const g = await import("./index.js");
let reachable = true;

before(async () => {
  try {
    await g.ping();
    await g.ensureSchema();
  } catch {
    reachable = false;
  }
});
after(async () => {
  if (reachable) {
    await (await g.graph()).delete().catch(() => {});
    for (const u of ["test-alice", "test-bob"]) await (await g.graph(g.tenantGraph(u))).delete().catch(() => {});
  }
  await g.close();
});
const live = (name: string, fn: () => Promise<void>) =>
  test(name, async (t) => {
    if (!reachable) return t.skip("FalkorDB not running (npm run db)");
    await fn();
  });

describe("record collections", () => {
  live("round-trips nested fields, dates and scalar lists", async () => {
    const at = new Date("2026-10-18T10:00:00Z");
    await g.col.runs.insertOne({ _id: "r1", board_id: "b1", stage: "checks", passed: false, failures: [{ check: "pullups", detail: "SDA floats" }], tags: ["a", "b"], ts: at });
    const r = await g.col.runs.findOne({ _id: "r1" });
    assert.deepEqual(r?.failures, [{ check: "pullups", detail: "SDA floats" }]);
    assert.deepEqual(r?.tags, ["a", "b"]);
    assert.equal(r?.ts, at.toISOString());
  });

  live("insertOne refuses a duplicate id", async () => {
    await g.col.lessons.insertOne({ _id: "dup", pattern: "x", fix: "y", active: true });
    await assert.rejects(g.col.lessons.insertOne({ _id: "dup", pattern: "x", fix: "y" }), g.DuplicateKeyError);
  });

  live("filters: $in, $ne, $exists, $or, sort and limit", async () => {
    for (let i = 0; i < 5; i++) await g.col.boards.insertOne({ _id: `bv${i}`, board_id: i < 3 ? "A" : "B", n: i, ...(i === 4 && { deliverables: { pcb: "x" } }) });
    assert.equal(await g.col.boards.countDocuments({ board_id: "A" }), 3);
    assert.deepEqual((await g.col.boards.find({ n: { $in: [1, 3] } }, { sort: { n: 1 } }).toArray()).map((d) => d.n), [1, 3]);
    assert.equal((await g.col.boards.findOne({ deliverables: { $exists: true } }))?._id, "bv4");
    assert.equal(await g.col.boards.countDocuments({ $or: [{ n: 0 }, { n: 4 }] }), 2);
    assert.equal((await g.col.boards.findOne({ board_id: "A" }, { sort: { n: -1 } }))?.n, 2);
    assert.equal((await g.col.boards.find({ _id: { $ne: "bv0" } }).limit(2).toArray()).length, 2);
  });

  live("updates: $set/$unset/$inc, upsert with $setOnInsert", async () => {
    await g.col.lessons.updateOne({ _id: "u1" }, { $set: { pattern: "p" }, $setOnInsert: { times_helped: 0 } }, { upsert: true });
    await g.col.lessons.updateOne({ _id: "u1" }, { $inc: { times_helped: 2 }, $unset: { pattern: "" } });
    const l = await g.col.lessons.findOne({ _id: "u1" });
    assert.equal(l?.times_helped, 2);
    assert.equal(l?.pattern, undefined);
  });

  live("concurrent findOneAndUpdate claims a record exactly once", async () => {
    await g.col.harness.insertOne({ _id: "v9", version: 9, verdict: "pending" });
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        g.col.harness.findOneAndUpdate({ verdict: "pending", claimed_by: { $exists: false } }, { $set: { claimed_by: `w${i}` } }, { returnDocument: "after" }),
      ),
    );
    assert.equal(claims.filter(Boolean).length, 1);
  });

  live("an update keeps the stored embedding", async () => {
    const v = Array.from({ length: g.EMBEDDING_DIMS }, (_, i) => (i === 0 ? 1 : 0));
    await g.col.lessons.insertOne({ _id: "e1", pattern: "i2c", active: true, embedder: "test", embedding: v });
    await g.col.lessons.updateOne({ _id: "e1" }, { $inc: { times_helped: 1 } });
    const [hit] = await g.vectorSearch("Lesson", v, 1, { embedder: "test" });
    assert.equal(hit?._id, "e1");
    assert.ok(hit.score > 0.99);
  });

  live("vector search never mixes embedders and honours filters", async () => {
    const v = Array.from({ length: g.EMBEDDING_DIMS }, (_, i) => (i === 1 ? 1 : 0));
    await g.col.lessons.insertOne({ _id: "e2", pattern: "other model", active: true, embedder: "other", embedding: v });
    await g.col.lessons.insertOne({ _id: "e3", pattern: "retired", active: false, embedder: "test", embedding: v });
    const hits = await g.vectorSearch("Lesson", v, 5, { embedder: "test", where: { active: true } });
    assert.ok(!hits.some((h) => h._id === "e2" || h._id === "e3"));
  });
});

describe("relationships", () => {
  live("a run links to its build, config, agent and failed checks", async () => {
    await g.col.harness.insertOne({ _id: "v0", version: 0, verdict: "kept", rules: ["I2C lines need pull-ups"], parent: null });
    await g.col.runs.replaceOne({ _id: "r2" }, { board_id: "b2", spec_id: "t04", harness_version: 0, stage: "checks", passed: false, failures: [{ check: "pullups", detail: "x" }], ts: new Date().toISOString() }, { upsert: true });
    const trace = await g.traceBuild("b2");
    const types = new Set(trace.edges.map((e) => e.type));
    for (const t of ["OF_BUILD", "UNDER", "BY_AGENT", "FAILED_CHECK", "HAS_RULE"]) assert.ok(types.has(t), `missing ${t}`);
    assert.ok(trace.nodes.some((n) => n.type === "agent" && n.label === "checker"));
  });

  live("re-writing a run re-derives its edges instead of piling them up", async () => {
    await g.col.runs.replaceOne({ _id: "r2" }, { board_id: "b2", harness_version: 0, stage: "checks", passed: true, failures: [], ts: new Date().toISOString() }, { upsert: true });
    const [row] = await g.cypher<{ n: number }>(`MATCH (:Run {_id: 'r2'})-[r:FAILED_CHECK]->() RETURN count(r) AS n`);
    assert.equal(row.n, 0);
  });
});

describe("per-user memory", () => {
  live("each user's history lives in its own graph", async () => {
    await g.appendEpisode("test-alice", { role: "user", text: "USB-C LED board" });
    await g.appendEpisode("test-alice", { role: "kaizen", text: "Built b1: passed", board_id: "b1", passed: true });
    await g.appendEpisode("test-bob", { role: "user", text: "I2C sensor" });
    const alice = await g.recentEpisodes("test-alice");
    const bob = await g.recentEpisodes("test-bob");
    assert.equal(alice.length, 2);
    assert.equal(alice[0].role, "kaizen"); // newest first
    assert.deepEqual(bob.map((e) => e.text), ["I2C sensor"]);
    assert.notEqual(g.tenantGraph("test-alice"), g.tenantGraph("test-bob"));
    const [chain] = await g.cypher<{ n: number }>(`MATCH (:Episode)-[r:NEXT]->(:Episode) RETURN count(r) AS n`, undefined, { graph: g.tenantGraph("test-alice") });
    assert.equal(chain.n, 1);
  });

  live("forgetUser wipes only that user", async () => {
    await g.forgetUser("test-bob");
    assert.equal((await g.recentEpisodes("test-bob")).length, 0);
    assert.equal((await g.recentEpisodes("test-alice")).length, 2);
  });
});

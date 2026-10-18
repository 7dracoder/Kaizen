// Reply parsing for gateways that don't enforce response_format. Run: npm run test:router
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonContent } from "./router.ts";

test("parses a bare object, a fenced block, and an object wrapped in prose", () => {
  assert.deepEqual(parseJsonContent('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonContent('Here you go:\n```json\n{"b":[1,2]}\n```'), { b: [1, 2] });
  assert.deepEqual(parseJsonContent('I will analyze the failures.\n{"diagnosis":[{"check":"pullups"}]}\nDone.'), { diagnosis: [{ check: "pullups" }] });
});

test("throws when there is no JSON object at all", () => {
  assert.throws(() => parseJsonContent("## 1. Diagnosis\nSDA has no pull-up"));
});

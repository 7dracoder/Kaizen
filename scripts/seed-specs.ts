// Copies the public spec text (specs/specs.json + specs/finale.json) into the graph so the web app can offer them.
// Only { _id, spec_id, split, text }: no hidden-check content. Safe to re-run. `npm run setup` does this too.
//   npm run seed:specs
import specs from "../specs/specs.json" with { type: "json" };
import finale from "../specs/finale.json" with { type: "json" };
import { client, col, connect } from "../apps/worker/src/db.ts";

const all = [
  ...(specs as { _id: string; split: string; text: string }[]).map(({ _id, split, text }) => ({ _id, spec_id: _id, split, text })),
  { _id: finale._id, spec_id: finale._id, split: "finale", text: finale.text },
];

await connect();
for (const s of all) await col.specs.replaceOne({ _id: s._id }, s, { upsert: true });
console.log(`specs: ${all.length}`);
await client.close();

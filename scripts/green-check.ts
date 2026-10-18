// Checks every configured service with one real call each, and says which optional ones are off.
//   npm run green                      all checks
//   npm run green -- falkordb voyage   only the named checks
// Paid checks (models: one tiny cheap-model call; voyage: one embedding + one rerank) only run when their key is set.
// Never prints key values.
import { Client as LangSmith } from "langsmith";
import { cypher, falkorUrl, graphName, listGraphs, ping } from "@kaizen/graph";
import { aiBaseUrl, aiApiKey } from "../apps/worker/src/tools/router.ts";

const only = new Set(process.argv.slice(2));
let failed = 0;

async function check(name: string, fn: () => Promise<string>) {
  if (only.size && !only.has(name)) return;
  try {
    console.log(`✓ ${name.padEnd(9)} ${await fn()}`);
  } catch (err) {
    failed++;
    console.log(`✗ ${name.padEnd(9)} ${err instanceof Error ? err.message : String(err)}`);
  }
}
const skip = (why: string) => `— skipped: ${why}`;

async function post(url: string, key: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

await check("falkordb", async () => {
  const ms = await ping();
  const [row] = await cypher<{ n: number }>("MATCH (n) RETURN count(n) AS n", undefined, { readOnly: true });
  const graphs = await listGraphs();
  return `${falkorUrl()} answered in ${ms} ms; graph "${graphName()}" has ${row?.n ?? 0} nodes; ${graphs.length} graph(s) in the instance`;
});

await check("models", async () => {
  const key = aiApiKey();
  if (!key) return skip("AI_API_KEY not set (board builds need it)");
  const model = process.env.MODEL_CHEAP || "openai/gpt-4o-mini";
  const res = await post(`${aiBaseUrl()}/chat/completions`, key, {
    model,
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    max_tokens: 5,
  });
  const reply = String(res.choices?.[0]?.message?.content ?? "").trim().slice(0, 20);
  return `${new URL(aiBaseUrl()).host} · ${model} replied "${reply}"`;
});

await check("strong", async () => {
  const key = aiApiKey();
  if (!key) return skip("AI_API_KEY not set");
  const model = process.env.MODEL_STRONG || "anthropic/claude-sonnet-4.5";
  const res = await post(`${aiBaseUrl()}/chat/completions`, key, {
    model,
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    max_tokens: 5,
  });
  return `${model} replied "${String(res.choices?.[0]?.message?.content ?? "").trim().slice(0, 20)}"`;
});

await check("voyage", async () => {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return skip("VOYAGE_API_KEY not set; memory uses the local hashing embedder (lower recall)");
  const model = process.env.VOYAGE_MODEL || "voyage-4";
  const dims = Number(process.env.EMBEDDING_DIMS || 1024);
  const emb = await post("https://api.voyageai.com/v1/embeddings", key, { input: ["decoupling cap near MCU power pin"], model, input_type: "document" });
  const len = emb.data[0].embedding.length;
  if (len !== dims) throw new Error(`${model} returned ${len} dims but the vector indexes expect ${dims}`);
  const rr = await post("https://api.voyageai.com/v1/rerank", key, {
    query: "I2C pull-ups",
    documents: ["100nF cap per IC", "I2C lines need pull-ups"],
    model: process.env.VOYAGE_RERANK_MODEL || "rerank-2.5",
  });
  if (rr.data[0].index !== 1) throw new Error("rerank put the wrong document first");
  return `${model} embedding (${len} dims) and rerank ok`;
});

await check("langsmith", async () => {
  if (process.env.LANGSMITH_TRACING !== "true" || !process.env.LANGSMITH_API_KEY) return skip("tracing off (optional)");
  const client = new LangSmith();
  let n = 0;
  for await (const _ of client.listProjects()) { n++; break; }
  return `API key accepted (${n ? "projects visible" : "no projects yet"})`;
});

await check("auth", async () => {
  const google = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
  const resend = Boolean(process.env.AUTH_RESEND_KEY);
  if (!google && !resend) return skip("no sign-in provider; the app runs in anonymous mode");
  if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET is required once a sign-in provider is set");
  if (resend) {
    const res = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${process.env.AUTH_RESEND_KEY}` } });
    if (res.status === 401 || res.status === 403) throw new Error(`Resend key rejected (${res.status})`);
  }
  return `${[google && "Google", resend && "email magic link (Resend key accepted)"].filter(Boolean).join(" + ")} configured` +
    (google ? "; Google is verified only by signing in" : "");
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall configured services answered");
process.exit(failed ? 1 : 0);

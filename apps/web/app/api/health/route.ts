// Is the front end actually talking to FalkorDB? Cheap enough to poll, and it
// answers the one question you want answered before a demo.

import { NextResponse } from "next/server";

import { listGraphs } from "@kaizen/graph";

import { graphConfigured, db, readGraph } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();

  const result = await readGraph(async () => {
    const database = db();
    const names = ["runs", "boards", "harness_versions", "lessons", "subcircuits", "work_queue"];
    const counts = Object.fromEntries(
      await Promise.all(
        names.map(async (n) => [n, await database.collection(n).estimatedDocumentCount()] as const),
      ),
    );
    const graphs = await listGraphs();
    return {
      database: database.databaseName,
      counts,
      user_graphs: graphs.filter((g) => g.startsWith("kaizen_user_")).length,
      embedder: process.env.VOYAGE_API_KEY ? "voyage" : "local-hash (offline fallback)",
    };
  });

  if (!result.ok) {
    return NextResponse.json(
      { connected: false, configured: graphConfigured(), error: result.error },
      { status: 503 },
    );
  }

  return NextResponse.json(
    { connected: true, configured: true, latency_ms: Date.now() - started, ...result.data },
    { headers: { "cache-control": "no-store" } },
  );
}

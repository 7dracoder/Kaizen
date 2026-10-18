// The graph as nodes + links for the live network view, straight from FalkorDB.
//   GET /api/graph/network                -> overview of the shared memory
//   GET /api/graph/network?board_id=<id>  -> one build's neighbourhood (runs, agents, checks, lessons, configs, queue)
// Every response lists the Cypher it ran, with row counts and timings, so the view can show its own queries.
import { NextResponse } from "next/server";
import { network } from "@kaizen/graph";

import { readGraph } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const boardId = url.searchParams.get("board_id");
  if (boardId !== null && !SAFE_ID.test(boardId)) return NextResponse.json({ error: "bad board id" }, { status: 400 });
  const limit = Number(url.searchParams.get("limit") ?? 400) || 400;
  const result = await readGraph(() => network({ boardId: boardId ?? undefined, limit }));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 503 });
  return NextResponse.json(result.data, { headers: { "cache-control": "no-store" } });
}

// What the shared memory graph holds: node and relationship counts, the lessons that earned their place (multi-hop:
// how many passing attempts had each lesson in context), the most-failed checks, and the harness lineage.
//   GET /api/graph
//   GET /api/graph?board_id=<id>   -> the provenance trace of one build (nodes + edges)
import { NextResponse } from "next/server";
import { memorySummary, traceBuild } from "@kaizen/graph";

import { readGraph } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;

export async function GET(request: Request) {
  const boardId = new URL(request.url).searchParams.get("board_id");
  if (boardId !== null && !SAFE_ID.test(boardId)) return NextResponse.json({ error: "bad board id" }, { status: 400 });
  const result = await readGraph<unknown>(() => (boardId ? traceBuild(boardId) : memorySummary()));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 503 });
  return NextResponse.json(result.data, { headers: { "cache-control": "no-store" } });
}

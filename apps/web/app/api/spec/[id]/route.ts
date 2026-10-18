// One spec request's status: GET /api/spec/:id.
// status: queued → running → done | failed, plus board_id (join runs/boards on it), passed, attempts, error.

import { NextResponse } from "next/server";

import { db, readGraph } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-f0-9]{24}$/.test(id)) return NextResponse.json({ error: "bad request id" }, { status: 400 });

  const result = await readGraph(() => db().collection("spec_requests").findOne({ _id: id }));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 503 });
  if (!result.data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(result.data, { headers: { "cache-control": "no-store" } });
}

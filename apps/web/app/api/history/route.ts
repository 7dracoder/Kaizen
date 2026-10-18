// The signed-in user's own conversation history, read from their private memory graph.
//   GET /api/history -> { episodes, user } (401 when sign-in is configured and nobody is signed in;
//                                          { episodes: [], anonymous: true } when the deployment has no auth)
import { NextResponse } from "next/server";
import { recentEpisodes } from "@kaizen/graph";

import { auth, authConfigured } from "@/lib/auth";
import { readGraph } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!authConfigured()) return NextResponse.json({ episodes: [], anonymous: true });
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "sign in to see your history" }, { status: 401 });
  const result = await readGraph(() => recentEpisodes(userId, 30));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 503 });
  return NextResponse.json({ episodes: result.data }, { headers: { "cache-control": "no-store" } });
}

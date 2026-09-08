import { NextResponse } from "next/server";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { getAiOverview } from "@/core/ai/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/ai/status — connection state, installed models and resident models.
 *
 * Also what the "Test connection" button calls: testing a connection and
 * reporting its state are the same question, and two endpoints that probe the
 * same thing eventually disagree.
 */
export async function GET() {
  ensureDatabaseReady();
  const overview = await getAiOverview();
  return NextResponse.json(overview, { headers: { "Cache-Control": "no-store" } });
}

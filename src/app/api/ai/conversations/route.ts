import { NextResponse } from "next/server";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { listConversations } from "@/core/ai/conversations";

export const dynamic = "force-dynamic";

/** GET /api/ai/conversations — the history list, most recent first. */
export async function GET() {
  ensureDatabaseReady();
  return NextResponse.json(
    { conversations: listConversations() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

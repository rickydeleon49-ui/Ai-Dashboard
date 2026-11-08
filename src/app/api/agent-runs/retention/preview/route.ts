import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import { getRetentionDays } from "@/core/agents/roots";
import { planRetention } from "@/core/agents/retention";

export const dynamic = "force-dynamic";

/** What cleanup would do right now. Read-only: this route never deletes anything. */
export async function GET() {
  if (!isAgentRunsEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  ensureDatabaseReady();

  const retentionDays = await getRetentionDays();
  const plan = await planRetention(db, new Date());
  return NextResponse.json({ retentionDays, plan });
}

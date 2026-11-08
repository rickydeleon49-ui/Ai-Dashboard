import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import { requestResume } from "@/core/agents/resume";
import { getRun } from "@/core/agents/runs";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Queues an explicit resume of an interrupted, failed or stopped run. The check
 * happens here (409 with the reason when refused); the work happens in the runner.
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  if (!isAgentRunsEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  ensureDatabaseReady();

  const { id } = await context.params;
  const run = await getRun(db, id);

  if (!run) {
    return NextResponse.json({ error: "Agent run not found" }, { status: 404 });
  }

  const result = await requestResume(db, run.id);
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 409 });
  }

  return NextResponse.json({ ok: true }, { status: 202 });
}

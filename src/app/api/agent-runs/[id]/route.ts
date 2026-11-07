import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import { getRun } from "@/core/agents/runs";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

export async function GET(request: NextRequest, context: RouteContext) {
  if (!isAgentRunsEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  ensureDatabaseReady();

  const { id } = await Promise.resolve(context.params);
  const run = await getRun(db, id);

  if (!run) {
    return NextResponse.json({ error: "Agent run not found" }, { status: 404 });
  }

  return NextResponse.json({ run });
}

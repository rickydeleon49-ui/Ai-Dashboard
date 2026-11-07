import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import { isTerminalStatus } from "@/core/agents/types";
import { createIntent, getRun } from "@/core/agents/runs";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  if (!isAgentRunsEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  ensureDatabaseReady();

  const { id } = await context.params;
  const run = await getRun(db, id);

  if (!run) {
    return NextResponse.json({ error: "Agent run not found" }, { status: 404 });
  }

  if (isTerminalStatus(run.status)) {
    return NextResponse.json(
      { error: "Run is already terminal" },
      { status: 409 },
    );
  }

  await createIntent(db, run.id, "stop", {});

  return NextResponse.json({ ok: true }, { status: 202 });
}

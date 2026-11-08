import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import { DismissError, dismissRun, undismissRun } from "@/core/agents/dismiss";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

function dismissErrorResponse(error: unknown) {
  if (error instanceof DismissError) {
    const status = error.code === "not_found" ? 404 : 409;
    return NextResponse.json({ error: error.message }, { status });
  }
  throw error;
}

/** Dismisses a finished run (hides it; makes its worktree eligible for cleanup). */
export async function POST(_request: NextRequest, context: RouteContext) {
  if (!isAgentRunsEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  ensureDatabaseReady();

  const { id } = await context.params;
  try {
    const run = await dismissRun(db, id);
    return NextResponse.json({ run });
  } catch (error) {
    return dismissErrorResponse(error);
  }
}

/** Restores a dismissed run. */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  if (!isAgentRunsEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  ensureDatabaseReady();

  const { id } = await context.params;
  try {
    const run = await undismissRun(db, id);
    return NextResponse.json({ run });
  } catch (error) {
    return dismissErrorResponse(error);
  }
}

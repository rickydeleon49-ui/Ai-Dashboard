import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import { getRun } from "@/core/agents/runs";
import { deleteComment } from "@/core/agents/comments";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; commentId: string }> };

export async function DELETE(request: NextRequest, context: RouteContext) {
  if (!isAgentRunsEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  ensureDatabaseReady();

  const { id, commentId } = await context.params;
  const run = await getRun(db, id);

  if (!run) {
    return NextResponse.json({ error: "Agent run not found" }, { status: 404 });
  }

  const deleted = await deleteComment(db, id, commentId);
  if (!deleted) {
    return NextResponse.json({ error: "Comment not found" }, { status: 404 });
  }

  return new NextResponse(null, { status: 204 });
}

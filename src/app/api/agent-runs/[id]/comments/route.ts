import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import { getRun } from "@/core/agents/runs";
import {
  addComment,
  listComments,
  commentInputSchema,
} from "@/core/agents/comments";
import { commentRejectionReason, requestHasReviewStage } from "@/core/agents/comment-rules";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024; // 16 KB

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  if (!isAgentRunsEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  ensureDatabaseReady();

  const { id } = await context.params;
  const run = await getRun(db, id);

  if (!run) {
    return NextResponse.json({ error: "Agent run not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const roundParam = url.searchParams.get("round");
  let round: number | undefined;

  if (roundParam !== null) {
    const trimmed = roundParam.trim();
    if (!/^[0-3]$/.test(trimmed)) {
      return NextResponse.json(
        { error: "Invalid round parameter: must be an integer between 0 and 3" },
        { status: 400 },
      );
    }
    round = Number.parseInt(trimmed, 10);
  }

  const comments = await listComments(db, id, round);
  return NextResponse.json({ comments });
}

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

  const rejection = commentRejectionReason({
    status: run.status,
    hasReviewStage: requestHasReviewStage(run.request),
  });
  if (rejection) {
    return NextResponse.json({ error: rejection }, { status: 409 });
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: "Payload too large" },
        { status: 413 },
      );
    }
  }

  const rawBody = await request.text();
  const byteLength = Buffer.byteLength(rawBody, "utf8");
  if (byteLength > MAX_BODY_BYTES || rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "Payload too large" },
      { status: 413 },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = commentInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const comment = await addComment(db, id, parsed.data);
  return NextResponse.json({ comment }, { status: 201 });
}

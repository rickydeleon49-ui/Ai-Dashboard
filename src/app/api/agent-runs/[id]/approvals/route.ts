import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import { getRun } from "@/core/agents/runs";
import {
  ApprovalError,
  approvalEnvFor,
  approvalRequestSchema,
  listApprovals,
  requestApproval,
} from "@/core/agents/approvals";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;

type RouteContext = { params: Promise<{ id: string }> };

function approvalErrorResponse(error: unknown) {
  if (error instanceof ApprovalError) {
    const status = error.code === "not_found" ? 404 : error.code === "invalid" ? 400 : 409;
    return NextResponse.json({ error: error.message }, { status });
  }
  throw error;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  if (!isAgentRunsEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  ensureDatabaseReady();

  const { id } = await context.params;
  const run = await getRun(db, id);
  if (!run) {
    return NextResponse.json({ error: "Agent run not found" }, { status: 404 });
  }

  return NextResponse.json({ approvals: listApprovals(db, id) });
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

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request body too large" }, { status: 400 });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON" }, { status: 400 });
  }
  const parsed = approvalRequestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid approval request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const env = await approvalEnvFor(db, run);
    // Builds the preview only (read-only Git); nothing is executed here.
    const approval = await requestApproval(db, id, parsed.data.kind, parsed.data.target ?? {}, env);
    return NextResponse.json({ approval }, { status: 201 });
  } catch (error) {
    return approvalErrorResponse(error);
  }
}

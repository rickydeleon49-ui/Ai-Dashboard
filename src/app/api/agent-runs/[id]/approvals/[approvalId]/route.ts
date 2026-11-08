import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import {
  ApprovalError,
  approvalDecisionSchema,
  decideApproval,
  getApproval,
} from "@/core/agents/approvals";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; approvalId: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  if (!isAgentRunsEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  ensureDatabaseReady();

  const { id, approvalId } = await context.params;
  const existing = getApproval(db, approvalId);
  if (!existing || existing.runId !== id) {
    return NextResponse.json({ error: "Approval not found" }, { status: 404 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON" }, { status: 400 });
  }
  const parsed = approvalDecisionSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid decision", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    // Approving only queues an approval_execute intent; the runner executes it.
    const approval = await decideApproval(db, approvalId, parsed.data.decision);
    return NextResponse.json({ approval }, { status: parsed.data.decision === "approve" ? 202 : 200 });
  } catch (error) {
    if (error instanceof ApprovalError) {
      const status = error.code === "not_found" ? 404 : error.code === "invalid" ? 400 : 409;
      return NextResponse.json({ error: error.message }, { status });
    }
    throw error;
  }
}

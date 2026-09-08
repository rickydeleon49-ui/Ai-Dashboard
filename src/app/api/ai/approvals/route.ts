import { NextResponse } from "next/server";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { approvalPoliciesSchema } from "@/core/ai/approvals";
import { getApprovalPolicies, updateApprovalPolicies } from "@/core/ai/settings";

export const dynamic = "force-dynamic";

/** GET /api/ai/approvals — the policy an agent would run under. */
export async function GET() {
  ensureDatabaseReady();
  return NextResponse.json(
    { approvals: getApprovalPolicies() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * PATCH /api/ai/approvals — change one or more policies.
 *
 * Unknown actions and unknown policies are dropped by the schema rather than
 * rejecting the request, so a client that knows about an action this build does
 * not still changes the ones it shares. A body that names nothing recognisable
 * is a mistake worth reporting, though, rather than a silent no-op.
 */
export async function PATCH(request: Request) {
  ensureDatabaseReady();

  const parsed = approvalPoliciesSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Expected an object of action names to policies" },
      { status: 422 },
    );
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json(
      { error: "No known action was named" },
      { status: 422 },
    );
  }

  return NextResponse.json({ approvals: updateApprovalPolicies(parsed.data) });
}

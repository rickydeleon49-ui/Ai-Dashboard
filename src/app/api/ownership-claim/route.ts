import { NextResponse, type NextRequest } from "next/server";
import {
  accountsModeDisabledResponse,
  accountsModeEnabled,
  sessionFromRequest,
} from "@/core/auth/session";
import { claimOwnershipSchema } from "@/core/ownership-claim/schema";
import { claimOwnership, OwnershipClaimError } from "@/core/ownership-claim/service";

export const dynamic = "force-dynamic";

const STATUS_FOR_REASON: Record<OwnershipClaimError["reason"], number> = {
  not_available: 404,
  invalid_password: 401,
  already_claimed: 409,
  claim_in_progress: 409,
  claimant_mismatch: 403,
  workspace_not_owned: 403,
  workspace_mismatch: 403,
};

/**
 * POST — one-shot import of this deployment's legacy SQLite projects/tags
 * into the signed-in caller's personal workspace, proven to be the
 * deployment's operator by also supplying its DASHBOARD_PASSWORD. See
 * src/core/ownership-claim/service.ts for why this is safe to call more
 * than once (only the first succeeds) and never touches the SQLite source
 * data.
 */
export async function POST(request: NextRequest) {
  if (!accountsModeEnabled()) return accountsModeDisabledResponse();

  const session = await sessionFromRequest(request);
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json(
      { error: "Sign-in required." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = claimOwnershipSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 422 },
    );
  }

  try {
    const result = await claimOwnership(userId, parsed.data.password);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof OwnershipClaimError) {
      return NextResponse.json({ error: error.message }, { status: STATUS_FOR_REASON[error.reason] });
    }
    throw error;
  }
}

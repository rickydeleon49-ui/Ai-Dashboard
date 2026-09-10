import { NextResponse, type NextRequest } from "next/server";
import {
  accountsModeDisabledResponse,
  accountsModeEnabled,
  sessionFromRequest,
} from "@/core/auth/session";
import { acceptInvitationSchema } from "@/core/workspaces/schema";
import { acceptInvitation, InvitationError } from "@/core/workspaces/invitations";

export const dynamic = "force-dynamic";

const STATUS_FOR_REASON: Record<InvitationError["reason"], number> = {
  not_found: 404,
  revoked: 410,
  expired: 410,
  already_accepted: 409,
  email_mismatch: 403,
  already_member: 409,
};

/**
 * POST — redeem an invitation token, granting the signed-in caller
 * membership. Deliberately a POST driven from a real page (src/app/invite),
 * not a mutation triggered by the bare GET a clicked link performs —
 * an invitation is exactly the kind of consequential, one-shot action a
 * prefetch, a link scanner, or a browser's own GET should never trigger
 * by accident.
 */
export async function POST(request: NextRequest) {
  if (!accountsModeEnabled()) return accountsModeDisabledResponse();

  const session = await sessionFromRequest(request);
  const user = session?.user;
  if (!user?.id || !user.email) {
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

  const parsed = acceptInvitationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 422 },
    );
  }

  try {
    const membership = await acceptInvitation(parsed.data.token, {
      id: user.id,
      email: user.email,
    });
    return NextResponse.json({ membership });
  } catch (error) {
    if (error instanceof InvitationError) {
      return NextResponse.json({ error: error.message }, { status: STATUS_FOR_REASON[error.reason] });
    }
    throw error;
  }
}

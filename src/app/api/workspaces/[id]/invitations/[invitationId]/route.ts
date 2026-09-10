import { NextResponse, type NextRequest } from "next/server";
import {
  accountsModeDisabledResponse,
  accountsModeEnabled,
  sessionFromRequest,
} from "@/core/auth/session";
import { AuthorizationError, authorizationErrorResponse, requireRole } from "@/core/workspaces/authorization";
import { revokeInvitation } from "@/core/workspaces/invitations";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; invitationId: string }> };

/** DELETE — revoke a pending invitation. Owner/admin only, same as creating one. */
export async function DELETE(request: NextRequest, { params }: Context) {
  if (!accountsModeEnabled()) return accountsModeDisabledResponse();

  const session = await sessionFromRequest(request);
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json(
      { error: "Sign-in required." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { id: workspaceId, invitationId } = await params;
  try {
    await requireRole(workspaceId, userId, "admin");
  } catch (error) {
    if (error instanceof AuthorizationError) return authorizationErrorResponse(error);
    throw error;
  }

  await revokeInvitation(workspaceId, invitationId);
  return NextResponse.json({ ok: true });
}

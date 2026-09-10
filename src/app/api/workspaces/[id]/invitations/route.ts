import { NextResponse, type NextRequest } from "next/server";
import {
  accountsModeDisabledResponse,
  accountsModeEnabled,
  sessionFromRequest,
} from "@/core/auth/session";
import { AuthorizationError, authorizationErrorResponse, requireRole } from "@/core/workspaces/authorization";
import { createInvitationSchema } from "@/core/workspaces/schema";
import { createInvitation, listInvitations } from "@/core/workspaces/invitations";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function requireSession(request: NextRequest): Promise<string | NextResponse> {
  const session = await sessionFromRequest(request);
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json(
      { error: "Sign-in required." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  return userId;
}

/** GET — every invitation (pending, accepted, revoked) for a workspace. Admin/owner only, same as creating one. */
export async function GET(request: NextRequest, { params }: Context) {
  if (!accountsModeEnabled()) return accountsModeDisabledResponse();
  const userId = await requireSession(request);
  if (userId instanceof NextResponse) return userId;

  const { id: workspaceId } = await params;
  try {
    await requireRole(workspaceId, userId, "admin");
  } catch (error) {
    if (error instanceof AuthorizationError) return authorizationErrorResponse(error);
    throw error;
  }

  const invitations = await listInvitations(workspaceId);
  return NextResponse.json({ invitations });
}

/**
 * POST — invite someone by email. Only an owner or admin may invite, and
 * never at the owner role — INVITABLE_ROLES excludes it, so the schema
 * already rejects a request that tries. Re-inviting an address with a
 * still-pending invitation refreshes it (see createInvitation's own
 * comment) rather than erroring.
 */
export async function POST(request: NextRequest, { params }: Context) {
  if (!accountsModeEnabled()) return accountsModeDisabledResponse();
  const userId = await requireSession(request);
  if (userId instanceof NextResponse) return userId;

  const { id: workspaceId } = await params;
  try {
    await requireRole(workspaceId, userId, "admin");
  } catch (error) {
    if (error instanceof AuthorizationError) return authorizationErrorResponse(error);
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = createInvitationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid invitation" },
      { status: 422 },
    );
  }

  const { invitation, token } = await createInvitation(
    workspaceId,
    userId,
    parsed.data.email,
    parsed.data.role,
  );

  // The raw token exists only here and in the link itself — nothing else
  // ever gets it back, since only its hash is persisted. Building the
  // actual invite link (and sending it) is not yet wired up; the caller
  // gets the token so a UI can construct /invite?token=... itself for now.
  return NextResponse.json({ invitation, token }, { status: 201 });
}

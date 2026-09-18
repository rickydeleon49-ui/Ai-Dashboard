import { NextResponse, type NextRequest } from "next/server";
import {
  accountsModeDisabledResponse,
  accountsModeEnabled,
  sessionFromRequest,
} from "@/core/auth/session";
import {
  AuthorizationError,
  authorizationErrorResponse,
  requireRole,
} from "@/core/workspaces/authorization";
import { updateMemberSchema } from "@/core/workspaces/schema";
import {
  getMembership,
  getMemberSummary,
  LastOwnerError,
  removeMember,
  updateMemberRole,
  updateMemberStatus,
} from "@/core/workspaces/service";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; userId: string }> };

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

/**
 * PATCH /api/workspaces/[id]/members/[userId]
 * Admin level and up.
 * Body: { role?, status? }
 * - Admins can change members and viewers only (cannot modify owners/admins, cannot grant owner/admin).
 * - Owners can change anyone's role (including granting admin or owner), subject to the last active owner trigger.
 * - status ∈ {'active','suspended','removed'}. Never 'invited'.
 * - Target not a member of this workspace -> 404.
 * - Last-owner violation -> 409.
 */
export async function PATCH(request: NextRequest, { params }: Context) {
  if (!accountsModeEnabled()) return accountsModeDisabledResponse();
  const sessionUserId = await requireSession(request);
  if (sessionUserId instanceof NextResponse) return sessionUserId;

  const { id: workspaceId, userId: targetUserId } = await params;
  let callerMembership;
  try {
    callerMembership = await requireRole(workspaceId, sessionUserId, "admin");
  } catch (error) {
    if (error instanceof AuthorizationError) return authorizationErrorResponse(error);
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Body must be JSON" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const parsed = updateMemberSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid update." },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }

  const targetMembership = await getMembership(workspaceId, targetUserId);
  if (!targetMembership) {
    return NextResponse.json(
      { error: "Member not found in this workspace." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (callerMembership.role === "admin") {
    if (targetMembership.role === "owner" || targetMembership.role === "admin") {
      return NextResponse.json(
        { error: "Admins cannot modify owners or other admins." },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (parsed.data.role === "owner" || parsed.data.role === "admin") {
      return NextResponse.json(
        { error: "Admins cannot grant admin or owner role." },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  try {
    if (parsed.data.role) {
      await updateMemberRole(workspaceId, targetUserId, parsed.data.role);
    }
    if (parsed.data.status) {
      await updateMemberStatus(workspaceId, targetUserId, parsed.data.status);
    }
  } catch (error) {
    if (error instanceof LastOwnerError) {
      return NextResponse.json(
        { error: error.message },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    throw error;
  }

  const member = await getMemberSummary(workspaceId, targetUserId);
  return NextResponse.json({ member }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * DELETE /api/workspaces/[id]/members/[userId]
 * Soft remove (sets status = 'removed').
 * Admin level and up.
 * - Admins can remove members and viewers only. They cannot remove owners or other admins.
 * - Owners can remove anyone, subject to the last-owner trigger.
 * - Target not a member of this workspace -> 404.
 * - Last-owner violation -> 409.
 */
export async function DELETE(request: NextRequest, { params }: Context) {
  if (!accountsModeEnabled()) return accountsModeDisabledResponse();
  const sessionUserId = await requireSession(request);
  if (sessionUserId instanceof NextResponse) return sessionUserId;

  const { id: workspaceId, userId: targetUserId } = await params;
  let callerMembership;
  try {
    callerMembership = await requireRole(workspaceId, sessionUserId, "admin");
  } catch (error) {
    if (error instanceof AuthorizationError) return authorizationErrorResponse(error);
    throw error;
  }

  const targetMembership = await getMembership(workspaceId, targetUserId);
  if (!targetMembership) {
    return NextResponse.json(
      { error: "Member not found in this workspace." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (callerMembership.role === "admin") {
    if (targetMembership.role === "owner" || targetMembership.role === "admin") {
      return NextResponse.json(
        { error: "Admins cannot remove owners or other admins." },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  try {
    await removeMember(workspaceId, targetUserId);
  } catch (error) {
    if (error instanceof LastOwnerError) {
      return NextResponse.json(
        { error: error.message },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    throw error;
  }

  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

import "server-only";

import { NextResponse } from "next/server";
import { getMembership } from "./service";
import { WORKSPACE_ROLES, type WorkspaceMembership, type WorkspaceRole } from "./types";

/**
 * Higher ranks can do everything a lower rank can. WORKSPACE_ROLES is
 * ordered most-to-least powerful ("owner" first), so the rank is the
 * reverse of its array index — owner must end up with the *highest*
 * number, not the lowest.
 */
const ROLE_RANK: Record<WorkspaceRole, number> = Object.fromEntries(
  WORKSPACE_ROLES.map((role, index) => [role, WORKSPACE_ROLES.length - index]),
) as Record<WorkspaceRole, number>;

export type AuthorizationFailureReason =
  | "unauthenticated"
  | "not_a_member"
  | "insufficient_role"
  | "inactive_member";

/**
 * Thrown by requireRole() when a caller may not perform a workspace-scoped
 * operation. Route handlers catch this and map it to a response via
 * authorizationErrorResponse() — the reason decides 401 vs 403.
 */
export class AuthorizationError extends Error {
  readonly reason: AuthorizationFailureReason;

  constructor(reason: AuthorizationFailureReason, message: string) {
    super(message);
    this.name = "AuthorizationError";
    this.reason = reason;
  }
}

/**
 * Confirms the given user may act on workspaceId at minimumRole or above,
 * re-deriving their membership fresh from workspace_member on every call —
 * never trust a client-supplied role, a role cached from earlier in the
 * request, or the mere existence of a session. This is the defense-in-depth
 * check the plan calls for: proxy.ts only confirms *someone* is signed in,
 * never that they belong to the specific workspace a route operates on.
 *
 * Returns the membership on success, so a caller who also needs the role
 * (or invitedBy, createdAt) doesn't have to look it up a second time.
 */
export async function requireRole(
  workspaceId: string,
  userId: string | undefined | null,
  minimumRole: WorkspaceRole,
): Promise<WorkspaceMembership> {
  if (!userId) {
    throw new AuthorizationError("unauthenticated", "Sign-in required.");
  }

  const membership = await getMembership(workspaceId, userId);
  if (!membership) {
    throw new AuthorizationError("not_a_member", "You are not a member of this workspace.");
  }

  if (membership.status !== "active") {
    throw new AuthorizationError(
      "inactive_member",
      "Your membership in this workspace is not active.",
    );
  }

  if (ROLE_RANK[membership.role] < ROLE_RANK[minimumRole]) {
    throw new AuthorizationError(
      "insufficient_role",
      `This action requires the ${minimumRole} role or higher; you have ${membership.role}.`,
    );
  }

  return membership;
}

/** Maps an AuthorizationError to the JSON response a route handler should return. */
export function authorizationErrorResponse(error: AuthorizationError): NextResponse {
  const status = error.reason === "unauthenticated" ? 401 : 403;
  return NextResponse.json(
    { error: error.message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

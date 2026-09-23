import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { isAccountsMode } from "@/lib/auth-mode";
import {
  CURRENT_WORKSPACE_COOKIE,
  resolveWorkspaceAndUserForRequest,
} from "@/core/workspaces/current-workspace";
import {
  AuthorizationError,
  authorizationErrorResponse,
  requireRole,
} from "@/core/workspaces/authorization";

export interface InboxContext {
  workspaceId: string;
  /** Always the session user. No inbox route accepts a user or recipient id. */
  userId: string;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function inboxJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function inboxNotFound(message = "Not found."): NextResponse {
  return inboxJson({ error: message }, 404);
}

/**
 * Authorizes a /api/inbox request (design note §8, §11). Returns the caller's
 * active workspace and user, or the response to send instead:
 *
 * - outside accounts mode: 404, before any session, workspace or database work
 *   (desktop deliberately has no collaboration inbox — §9)
 * - no session: 401
 * - the cookie names a workspace where the caller is suspended or removed: 403,
 *   rather than silently falling back to another workspace
 * - not an active member of the resolved workspace: 403
 *
 * Any active role (viewer and up) may manage their own notifications.
 */
export async function resolveInboxContext(request: NextRequest): Promise<InboxContext | NextResponse> {
  if (!isAccountsMode()) return inboxNotFound();

  const resolved = await resolveWorkspaceAndUserForRequest(request);
  if (!resolved?.userId) return inboxJson({ error: "Sign-in required." }, 401);
  const { workspaceId, userId } = resolved;

  const requestedWorkspace = request.cookies.get(CURRENT_WORKSPACE_COOKIE)?.value;
  if (requestedWorkspace) {
    const { getMembership } = await import("@/core/workspaces/service");
    const requested = await getMembership(requestedWorkspace, userId);
    if (requested && requested.status !== "active") {
      return authorizationErrorResponse(
        new AuthorizationError("inactive_member", "Your membership in this workspace is not active."),
      );
    }
  }

  try {
    await requireRole(workspaceId, userId, "viewer");
  } catch (error) {
    if (error instanceof AuthorizationError) return authorizationErrorResponse(error);
    throw error;
  }
  return { workspaceId, userId };
}

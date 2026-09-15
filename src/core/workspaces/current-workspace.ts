import "server-only";

import type { NextRequest } from "next/server";
import { LOCAL_WORKSPACE_ID } from "@/db/repositories";
import type { WorkspaceWithRole } from "./types";

/**
 * Which workspace a signed-in user last selected — hosted multi-user mode
 * only. Set by PUT /api/workspaces/current after re-checking membership;
 * never trust the cookie's value alone without confirming it against a
 * live membership list, since anything client-supplied can be stale (the
 * user was since removed) or simply wrong.
 */
export const CURRENT_WORKSPACE_COOKIE = "cc-current-workspace";

/**
 * Picks which of a user's workspaces should be treated as "current":
 * the cookie's value if it's still a real membership, otherwise their
 * personal workspace, otherwise whichever workspace sorts first (a user
 * always has a personal workspace once signed in, so that fallback is
 * only for defensive completeness).
 */
export function resolveCurrentWorkspace(
  memberships: WorkspaceWithRole[],
  cookieValue: string | undefined,
): WorkspaceWithRole | null {
  if (memberships.length === 0) return null;
  const fromCookie = cookieValue && memberships.find((w) => w.id === cookieValue);
  if (fromCookie) return fromCookie;
  return memberships.find((w) => w.kind === "personal") ?? memberships[0]!;
}

/**
 * The workspace id the project domain should query for `userId`:
 * `LOCAL_WORKSPACE_ID` everywhere except accounts mode, where it's their
 * current workspace (see `resolveCurrentWorkspace`), self-healing via
 * `ensurePersonalWorkspace` the same way `src/auth.ts`'s `events.createUser`
 * does — see that handler's own comment, which already anticipated this.
 * Returns null only when there is no session at all: proxy.ts already
 * blocks that in accounts mode, so this is defense in depth, not the
 * primary gate (see docs/ARCHITECTURE.md's security posture notes on why
 * proxy.ts is never trusted alone).
 */
export async function resolveWorkspaceId(
  userId: string | null | undefined,
  cookieValue: string | undefined,
): Promise<string | null> {
  if (process.env.AUTH_MODE !== "accounts" || !process.env.DATABASE_URL) {
    return LOCAL_WORKSPACE_ID;
  }
  if (!userId) return null;

  const { ensurePersonalWorkspace, listWorkspacesForUser } = await import("./service");
  await ensurePersonalWorkspace(userId);
  const memberships = await listWorkspacesForUser(userId, 50);
  return resolveCurrentWorkspace(memberships, cookieValue)?.id ?? null;
}

/**
 * `resolveWorkspaceId` for an API route handler. `@/core/auth/session` is
 * imported dynamically for the same reason every other accounts-mode-only
 * module in this codebase does — see proxy.ts's own `handleAccountsMode`
 * comment: this function runs unconditionally in every mode (it's the
 * fallback path to `LOCAL_WORKSPACE_ID` too), so a static import would
 * pull Auth.js into builds that never use it.
 */
export async function resolveWorkspaceIdForRequest(request: NextRequest): Promise<string | null> {
  if (process.env.AUTH_MODE !== "accounts" || !process.env.DATABASE_URL) {
    return LOCAL_WORKSPACE_ID;
  }
  const { sessionFromRequest } = await import("@/core/auth/session");
  const session = await sessionFromRequest(request);
  return resolveWorkspaceId(session?.user?.id, request.cookies.get(CURRENT_WORKSPACE_COOKIE)?.value);
}

/** `resolveWorkspaceId` for a Server Component page (next/headers instead of a NextRequest). */
export async function resolveWorkspaceIdForPage(): Promise<string | null> {
  if (process.env.AUTH_MODE !== "accounts" || !process.env.DATABASE_URL) {
    return LOCAL_WORKSPACE_ID;
  }
  const [{ auth }, { cookies }] = await Promise.all([import("@/auth"), import("next/headers")]);
  const session = await auth();
  const cookieStore = await cookies();
  return resolveWorkspaceId(session?.user?.id, cookieStore.get(CURRENT_WORKSPACE_COOKIE)?.value);
}

/**
 * `resolveWorkspaceAndUserForRequest` for a Server Component page — what a
 * read-only page needs when it has to filter by the caller's own identity
 * (My Work's "assigned to me"), not just their workspace. There is no
 * write-capable page equivalent because pages never mutate directly; only
 * route handlers call `requireRole()`.
 */
export async function resolveWorkspaceAndUserForPage(): Promise<{
  workspaceId: string;
  userId: string | null;
} | null> {
  if (process.env.AUTH_MODE !== "accounts" || !process.env.DATABASE_URL) {
    return { workspaceId: LOCAL_WORKSPACE_ID, userId: null };
  }
  const [{ auth }, { cookies }] = await Promise.all([import("@/auth"), import("next/headers")]);
  const session = await auth();
  const userId = session?.user?.id ?? null;
  const cookieStore = await cookies();
  const workspaceId = await resolveWorkspaceId(userId, cookieStore.get(CURRENT_WORKSPACE_COOKIE)?.value);
  if (!workspaceId) return null;
  return { workspaceId, userId };
}

/**
 * Like `resolveWorkspaceIdForRequest`, but for a mutating route: also
 * returns the resolved userId (null outside accounts mode) so the caller
 * can additionally call `requireRole()`. `resolveWorkspaceId` already
 * guarantees the caller is *some* member of the workspace it returns (a
 * minimum of "viewer"), which is all a read needs — but "may read" is not
 * "may write", so every mutating project route must check the stronger
 * role itself; this only hands back what that check needs.
 */
export async function resolveWorkspaceAndUserForRequest(
  request: NextRequest,
): Promise<{ workspaceId: string; userId: string | null } | null> {
  if (process.env.AUTH_MODE !== "accounts" || !process.env.DATABASE_URL) {
    return { workspaceId: LOCAL_WORKSPACE_ID, userId: null };
  }
  const { sessionFromRequest } = await import("@/core/auth/session");
  const session = await sessionFromRequest(request);
  const userId = session?.user?.id ?? null;
  const workspaceId = await resolveWorkspaceId(userId, request.cookies.get(CURRENT_WORKSPACE_COOKIE)?.value);
  if (!workspaceId) return null;
  return { workspaceId, userId };
}

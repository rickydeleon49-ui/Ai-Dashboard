import "server-only";

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

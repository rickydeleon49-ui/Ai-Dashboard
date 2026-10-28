import "server-only";

import { resolveWorkspaceAndUserForPage } from "@/core/workspaces/current-workspace";
import { isAccountsMode } from "@/lib/auth-mode";

/**
 * What a knowledge page may show the caller: the workspace to read from, and
 * whether to offer writing controls at all.
 *
 * Presentation only. The API routes still call `requireRole(..., "member")`
 * on every write, so a viewer who reaches a form some other way is refused
 * there regardless. Desktop and single-user modes always write. Accounts mode
 * never touches the legacy SQLite database here: membership comes from
 * PostgreSQL through `core/workspaces/service`, imported only in that mode.
 */
export async function resolveKnowledgePageAccess(): Promise<{ workspaceId: string; canEdit: boolean } | null> {
  const resolved = await resolveWorkspaceAndUserForPage();
  if (!resolved) return null;
  const { workspaceId, userId } = resolved;
  if (!isAccountsMode()) return { workspaceId, canEdit: true };
  if (!userId) return { workspaceId, canEdit: false };

  const { getMembership } = await import("@/core/workspaces/service");
  const membership = await getMembership(workspaceId, userId);
  return {
    workspaceId,
    canEdit: membership?.status === "active" && membership.role !== "viewer",
  };
}

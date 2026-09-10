/** Framework-free domain types for the workspace domain (hosted multi-user mode only). */

export const WORKSPACE_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Roles an invitation may grant. Never "owner" — see workspace-invitations design notes. */
export const INVITABLE_ROLES = ["admin", "member", "viewer"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export type WorkspaceKind = "personal" | "team";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  kind: WorkspaceKind;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceMembership {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  invitedBy: string | null;
  createdAt: Date;
}

/** A workspace plus the current user's role in it — what a switcher/list needs. */
export interface WorkspaceWithRole extends Workspace {
  role: WorkspaceRole;
}

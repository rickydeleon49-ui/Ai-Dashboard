/** Framework-free domain types for the workspace domain (hosted multi-user mode only). */

export const WORKSPACE_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const WORKSPACE_MEMBER_STATUSES = ["active", "invited", "suspended", "removed"] as const;
export type WorkspaceMemberStatus = (typeof WORKSPACE_MEMBER_STATUSES)[number];

/** Roles an invitation may grant. Never "owner" — see workspace-invitations design notes. */
export const INVITABLE_ROLES = ["admin", "member", "viewer"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export type WorkspaceKind = "personal" | "team";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  kind: WorkspaceKind;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceMembership {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  status: WorkspaceMemberStatus;
  invitedBy: string | null;
  createdAt: Date;
}

/**
 * Safe member representation returned by directory queries.
 * Omits accounts, sessions, password hashes, tokens, and cross-workspace membership.
 */
export interface WorkspaceMemberSummary {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  role: WorkspaceRole;
  status: WorkspaceMemberStatus;
  joinedAt: Date;
}

/** A workspace plus the current user's role in it — what a switcher/list needs. */
export interface WorkspaceWithRole extends Workspace {
  role: WorkspaceRole;
}

/**
 * The raw token is never persisted (only its hash is) and so never appears
 * here — it exists only in the invite link itself, generated once at
 * creation time and handed back to the caller who requested it.
 */
export interface WorkspaceInvitation {
  id: string;
  workspaceId: string;
  email: string;
  role: InvitableRole;
  invitedBy: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  acceptedAt: Date | null;
  acceptedBy: string | null;
  createdAt: Date;
}

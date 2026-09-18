import "server-only";

import crypto from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getPgDb } from "@/db/pg-client";
import { workspaceInvitations, workspaceMembers, workspaces } from "@/db/schema.pg";
import { createId } from "@/lib/ids";
import { pgErrorCode, UNIQUE_VIOLATION } from "@/db/pg-errors";
import type { InvitableRole, WorkspaceInvitation, WorkspaceMembership } from "./types";

/** How long an invitation stays acceptable after being created or refreshed. */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InvitationFailureReason =
  | "not_found"
  | "revoked"
  | "expired"
  | "already_accepted"
  | "email_mismatch"
  | "already_member";

/** Thrown by acceptInvitation() when a token cannot be redeemed, and why. */
export class InvitationError extends Error {
  readonly reason: InvitationFailureReason;

  constructor(reason: InvitationFailureReason, message: string) {
    super(message);
    this.name = "InvitationError";
    this.reason = reason;
  }
}

function toInvitation(row: typeof workspaceInvitations.$inferSelect): WorkspaceInvitation {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    email: row.email,
    role: row.role as InvitableRole,
    invitedBy: row.invitedBy,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    acceptedAt: row.acceptedAt,
    acceptedBy: row.acceptedBy,
    createdAt: row.createdAt,
  };
}

/** sha-256 of the raw token — what's actually stored; the raw token never is. */
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Creates a pending invitation and returns the raw token alongside it — the
 * only place that token ever exists outside the invite link itself; only
 * its hash is persisted. Caller must already have confirmed the inviter's
 * owner/admin role (via requireRole) before calling this — this function
 * does not re-check it, matching updateMemberRole/removeMember's own
 * division of labor between authorization and mutation.
 *
 * Re-inviting an address that already has a pending invitation refreshes
 * it in place (new token, new expiry, possibly a new role) rather than
 * erroring — the partial unique index on schema.pg.ts's workspace_invitation
 * table means only one can exist per (workspace, email) at a time, and a
 * stale outstanding invite is exactly what a re-invite means to replace.
 * The old link's token stops working the moment this happens, since only
 * the new hash is stored.
 */
export async function createInvitation(
  workspaceId: string,
  invitedBy: string,
  email: string,
  role: InvitableRole,
): Promise<{ invitation: WorkspaceInvitation; token: string }> {
  const db = getPgDb();
  const normalizedEmail = email.trim().toLowerCase();
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  try {
    const [row] = await db
      .insert(workspaceInvitations)
      .values({
        id: createId("inv"),
        workspaceId,
        email: normalizedEmail,
        role,
        tokenHash,
        invitedBy,
        expiresAt,
      })
      .returning();
    if (!row) throw new Error("Failed to create invitation");
    return { invitation: toInvitation(row), token };
  } catch (error) {
    if (pgErrorCode(error) !== UNIQUE_VIOLATION) throw error;

    const [row] = await db
      .update(workspaceInvitations)
      .set({ role, tokenHash, invitedBy, expiresAt, revokedAt: null })
      .where(
        and(
          eq(workspaceInvitations.workspaceId, workspaceId),
          sql`lower(${workspaceInvitations.email}) = ${normalizedEmail}`,
          isNull(workspaceInvitations.acceptedAt),
          isNull(workspaceInvitations.revokedAt),
        ),
      )
      .returning();
    if (!row) throw new Error("Failed to refresh invitation");
    return { invitation: toInvitation(row), token };
  }
}

/** Every pending or past invitation for a workspace, newest first. */
export async function listInvitations(workspaceId: string): Promise<WorkspaceInvitation[]> {
  const db = getPgDb();
  const rows = await db
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.workspaceId, workspaceId))
    .orderBy(sql`${workspaceInvitations.createdAt} desc`);
  return rows.map(toInvitation);
}

/** Revokes a pending invitation. Idempotent: revoking twice, or an already-accepted one, is a no-op. */
export async function revokeInvitation(workspaceId: string, invitationId: string): Promise<void> {
  const db = getPgDb();
  await db
    .update(workspaceInvitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(workspaceInvitations.workspaceId, workspaceId),
        eq(workspaceInvitations.id, invitationId),
        isNull(workspaceInvitations.acceptedAt),
        isNull(workspaceInvitations.revokedAt),
      ),
    );
}

export interface InvitationPreview {
  workspaceName: string;
  email: string;
  role: InvitableRole;
  valid: boolean;
  reason: InvitationFailureReason | null;
}

/**
 * Read-only: what the accept page shows before the user confirms, without
 * mutating anything (no row lock, no side effects) — safe to call from a
 * GET/page render, unlike acceptInvitation. `valid`/`reason` reflect the
 * same checks acceptInvitation itself enforces, except for the email-match
 * check (this function doesn't know who is looking, since a signed-out
 * visitor can preview an invitation before being asked to sign in).
 */
export async function previewInvitation(token: string): Promise<InvitationPreview | null> {
  const db = getPgDb();
  const tokenHash = hashToken(token);
  const [row] = await db
    .select({ invitation: workspaceInvitations, workspaceName: workspaces.name })
    .from(workspaceInvitations)
    .innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
    .where(eq(workspaceInvitations.tokenHash, tokenHash))
    .limit(1);
  if (!row) return null;

  const { invitation, workspaceName } = row;
  let reason: InvitationFailureReason | null = null;
  if (invitation.revokedAt) reason = "revoked";
  else if (invitation.acceptedAt) reason = "already_accepted";
  else if (invitation.expiresAt.getTime() <= Date.now()) reason = "expired";

  return {
    workspaceName,
    email: invitation.email,
    role: invitation.role as InvitableRole,
    valid: reason === null,
    reason,
  };
}

/**
 * Redeems a raw invitation token for the given (already-authenticated)
 * user, granting them membership at the invited role.
 *
 * The row is locked (`SELECT ... FOR UPDATE`) inside a transaction before
 * any of the checks below run, so two concurrent accept attempts for the
 * same token can't both pass the "not yet accepted" check before either
 * commits — the second waits for the first's transaction to finish, then
 * sees it as already accepted.
 *
 * Every rejection reason matters, but requiring the accepting user's own
 * session email to match the invited address is the one most important
 * not to skip: without it, anyone who merely obtains the link (a forward,
 * a leaked URL, a shared inbox) could join as whoever was invited, not
 * just the intended recipient.
 */
export async function acceptInvitation(
  token: string,
  acceptingUser: { id: string; email: string },
): Promise<WorkspaceMembership> {
  const db = getPgDb();
  const tokenHash = hashToken(token);

  return db.transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.tokenHash, tokenHash))
      .for("update");

    if (!invitation) {
      throw new InvitationError("not_found", "This invitation link is not valid.");
    }
    if (invitation.revokedAt) {
      throw new InvitationError("revoked", "This invitation has been revoked.");
    }
    if (invitation.acceptedAt) {
      throw new InvitationError("already_accepted", "This invitation has already been used.");
    }
    if (invitation.expiresAt.getTime() <= Date.now()) {
      throw new InvitationError("expired", "This invitation has expired.");
    }
    if (invitation.email.toLowerCase() !== acceptingUser.email.trim().toLowerCase()) {
      throw new InvitationError(
        "email_mismatch",
        "This invitation was sent to a different email address.",
      );
    }

    const [existingMembership] = await tx
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, invitation.workspaceId),
          eq(workspaceMembers.userId, acceptingUser.id),
        ),
      )
      .limit(1);
    if (existingMembership) {
      throw new InvitationError("already_member", "You are already a member of this workspace.");
    }

    const [membership] = await tx
      .insert(workspaceMembers)
      .values({
        workspaceId: invitation.workspaceId,
        userId: acceptingUser.id,
        role: invitation.role,
        invitedBy: invitation.invitedBy,
      })
      .returning();
    if (!membership) throw new Error("Failed to record membership");

    await tx
      .update(workspaceInvitations)
      .set({ acceptedAt: new Date(), acceptedBy: acceptingUser.id })
      .where(eq(workspaceInvitations.id, invitation.id));

    return {
      workspaceId: membership.workspaceId,
      userId: membership.userId,
      role: membership.role as WorkspaceMembership["role"],
      status: membership.status as WorkspaceMembership["status"],
      invitedBy: membership.invitedBy,
      createdAt: membership.createdAt,
    };
  });
}

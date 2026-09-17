/**
 * Safe workspace ownership lifecycle tests (Phase 2 hardening):
 * Verifies that deleting a workspace creator's user account:
 * 1. Sets workspace.created_by to NULL (ON DELETE SET NULL) rather than cascading and destroying the workspace.
 * 2. Allows remaining owners to retain full control of the workspace.
 * 3. Prevents deleting the sole owner of a workspace (via prevent_last_owner_removal trigger).
 * 4. Preserves pending invitations by setting invited_by to NULL rather than cascading.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";
import { eq } from "drizzle-orm";

let db: typeof import("../../src/db/pg-client").getPgDb;
let users: typeof import("../../src/db/schema.pg").users;
let workspacesTable: typeof import("../../src/db/schema.pg").workspaces;
let workspaceMembers: typeof import("../../src/db/schema.pg").workspaceMembers;
let workspaceInvitations: typeof import("../../src/db/schema.pg").workspaceInvitations;
let workspacesService: typeof import("../../src/core/workspaces/service");
let invitationsService: typeof import("../../src/core/workspaces/invitations");

before(async () => {
  await migrate();
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  ({
    users,
    workspaces: workspacesTable,
    workspaceMembers,
    workspaceInvitations,
  } = await import("../../src/db/schema.pg"));
  workspacesService = await import("../../src/core/workspaces/service");
  invitationsService = await import("../../src/core/workspaces/invitations");
});

after(() => cleanup());

let userCounter = 0;
async function makeUser(email?: string): Promise<string> {
  userCounter += 1;
  const id = `user_lifecycle_${userCounter}_${Date.now()}`;
  await db().insert(users).values({ id, email: email ?? `${id}@example.com` });
  return id;
}

beforeEach(async () => {
  await db().delete(workspacesTable);
  await db().delete(users);
  userCounter = 0;
});

describe("Workspace creator account lifecycle", () => {
  it("preserves a team workspace with additional owners when creator account is deleted", async () => {
    const creatorId = await makeUser("creator@example.com");
    const coOwnerId = await makeUser("coowner@example.com");

    // Creator creates team workspace
    const teamWs = await workspacesService.createTeamWorkspace(creatorId, "Engineering Corp");
    assert.equal(teamWs.createdBy, creatorId);

    // Add second user as owner
    await db().insert(workspaceMembers).values({
      workspaceId: teamWs.id,
      userId: coOwnerId,
      role: "owner",
    });

    // Verify both are members
    const membersBefore = await workspacesService.listMembers(teamWs.id);
    assert.equal(membersBefore.length, 2);

    // Delete creator user account
    await db().delete(users).where(eq(users.id, creatorId));

    // Invariant: Workspace row MUST still exist!
    const wsAfter = await workspacesService.getWorkspace(teamWs.id);
    assert.ok(wsAfter, "Workspace must survive creator deletion");
    assert.equal(wsAfter.createdBy, null, "createdBy should be set to null");

    // Invariant: Co-owner retains ownership
    const coOwnerMembership = await workspacesService.getMembership(teamWs.id, coOwnerId);
    assert.ok(coOwnerMembership, "Remaining owner must keep membership");
    assert.equal(coOwnerMembership.role, "owner");

    // Invariant: Creator membership was cascaded away
    const creatorMembership = await workspacesService.getMembership(teamWs.id, creatorId);
    assert.equal(creatorMembership, null);
  });

  it("blocks deleting a creator who is the sole owner of a workspace (last owner trigger)", async () => {
    const soleCreatorId = await makeUser("sole@example.com");
    const teamWs = await workspacesService.createTeamWorkspace(soleCreatorId, "Solo Org");

    // Attempting to delete the user cascades to workspace_member, which triggers prevent_last_owner_removal
    await assert.rejects(
      async () => {
        await db().delete(users).where(eq(users.id, soleCreatorId));
      },
      (error: unknown) => {
        const msg = (error as any)?.cause?.message || String(error);
        assert.match(msg, /workspace must retain at least one owner/);
        return true;
      },
    );

    // Workspace and creator membership remain intact
    const ws = await workspacesService.getWorkspace(teamWs.id);
    assert.ok(ws);
    const membership = await workspacesService.getMembership(teamWs.id, soleCreatorId);
    assert.equal(membership?.role, "owner");
  });

  it("preserves pending invitations when inviter user account is deleted", async () => {
    const creatorId = await makeUser("inviter@example.com");
    const coOwnerId = await makeUser("coowner2@example.com");

    const teamWs = await workspacesService.createTeamWorkspace(creatorId, "Inviting Corp");
    await db().insert(workspaceMembers).values({
      workspaceId: teamWs.id,
      userId: coOwnerId,
      role: "owner",
    });

    // Creator invites a new team member
    const { invitation } = await invitationsService.createInvitation(
      teamWs.id,
      creatorId,
      "candidate@example.com",
      "member",
    );
    assert.equal(invitation.invitedBy, creatorId);

    // Delete creator user account
    await db().delete(users).where(eq(users.id, creatorId));

    // Verify invitation still exists in database with invitedBy: null
    const [invitationRow] = await db()
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.id, invitation.id))
      .limit(1);

    assert.ok(invitationRow, "Invitation must survive inviter account deletion");
    assert.equal(invitationRow.invitedBy, null, "invited_by should be set to null");
    assert.equal(invitationRow.email, "candidate@example.com");
  });
});

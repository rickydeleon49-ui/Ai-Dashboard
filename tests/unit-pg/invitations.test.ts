/**
 * The workspace invitation service, against real Postgres: create, accept,
 * revoke, and the rejections that matter — double-accept, accept-after-
 * revoke, accept-after-expiry, and (the one most important not to skip)
 * a mismatched email.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db.pg";

let db: typeof import("../../src/db/pg-client").getPgDb;
let users: typeof import("../../src/db/schema.pg").users;
let workspacesTable: typeof import("../../src/db/schema.pg").workspaces;
let workspaceInvitations: typeof import("../../src/db/schema.pg").workspaceInvitations;
let workspaces: typeof import("../../src/core/workspaces/service");
let invitations: typeof import("../../src/core/workspaces/invitations");
let InvitationError: typeof import("../../src/core/workspaces/invitations").InvitationError;

before(async () => {
  await migrate();
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  ({ users, workspaces: workspacesTable, workspaceInvitations } = await import(
    "../../src/db/schema.pg"
  ));
  workspaces = await import("../../src/core/workspaces/service");
  invitations = await import("../../src/core/workspaces/invitations");
  ({ InvitationError } = invitations);
});

after(() => cleanup());

let userCounter = 0;

/** Inserts a throwaway user row and returns its id. */
async function makeUser(email?: string): Promise<string> {
  userCounter += 1;
  const id = `user_${userCounter}_${Date.now()}`;
  await db().insert(users).values({ id, email: email ?? `${id}@example.com` });
  return id;
}

beforeEach(async () => {
  // Workspaces first: workspace_invitation.invited_by/accepted_by reference
  // users.id without cascade (an invitation is meant to outlive the user
  // who sent or accepted it, as a record — nothing in this app deletes
  // users today, so that has never mattered until now). Deleting a
  // workspace first removes its invitation rows via their own workspace_id
  // cascade, so no invitation row is left pointing at a user by the time
  // this deletes the users themselves.
  await db().delete(workspacesTable);
  await db().delete(users);
  userCounter = 0;
});

describe("createInvitation", () => {
  it("creates a pending invitation with a usable token", async () => {
    const owner = await makeUser();
    const ws = await workspaces.createTeamWorkspace(owner, "Acme");

    const { invitation, token } = await invitations.createInvitation(
      ws.id,
      owner,
      "New.Teammate@Example.com",
      "member",
    );

    assert.equal(invitation.email, "new.teammate@example.com", "email is normalized to lowercase");
    assert.equal(invitation.role, "member");
    assert.ok(token.length > 0);

    const preview = await invitations.previewInvitation(token);
    assert.equal(preview?.valid, true);
    assert.equal(preview?.workspaceName, "Acme");
  });

  it("refreshes rather than errors when re-inviting a still-pending address", async () => {
    const owner = await makeUser();
    const ws = await workspaces.createTeamWorkspace(owner, "Acme");

    const first = await invitations.createInvitation(ws.id, owner, "again@example.com", "viewer");
    const second = await invitations.createInvitation(ws.id, owner, "again@example.com", "admin");

    assert.equal(first.invitation.id, second.invitation.id, "same row, refreshed in place");
    assert.notEqual(first.token, second.token, "the token changes on refresh");

    // The old link no longer works — only the new hash is stored.
    const oldPreview = await invitations.previewInvitation(first.token);
    assert.equal(oldPreview, null);

    const newPreview = await invitations.previewInvitation(second.token);
    assert.equal(newPreview?.role, "admin");
  });
});

describe("acceptInvitation", () => {
  it("grants membership at the invited role", async () => {
    const owner = await makeUser();
    const ws = await workspaces.createTeamWorkspace(owner, "Acme");
    const invitee = await makeUser("invitee@example.com");

    const { token } = await invitations.createInvitation(ws.id, owner, "invitee@example.com", "member");
    const membership = await invitations.acceptInvitation(token, {
      id: invitee,
      email: "invitee@example.com",
    });

    assert.equal(membership.role, "member");
    assert.equal(membership.userId, invitee);

    const nowMember = await workspaces.getMembership(ws.id, invitee);
    assert.equal(nowMember?.role, "member");
  });

  it("accepts case-insensitively, matching how the email was normalized on invite", async () => {
    const owner = await makeUser();
    const ws = await workspaces.createTeamWorkspace(owner, "Acme");
    const invitee = await makeUser("Mixed.Case@Example.com");

    const { token } = await invitations.createInvitation(ws.id, owner, "mixed.case@EXAMPLE.com", "viewer");
    const membership = await invitations.acceptInvitation(token, {
      id: invitee,
      email: "Mixed.Case@Example.com",
    });
    assert.equal(membership.role, "viewer");
  });

  it("rejects an unknown token", async () => {
    const invitee = await makeUser("nobody@example.com");
    await assert.rejects(
      () => invitations.acceptInvitation("not-a-real-token", { id: invitee, email: "nobody@example.com" }),
      (error: unknown) => {
        assert.ok(error instanceof InvitationError);
        assert.equal(error.reason, "not_found");
        return true;
      },
    );
  });

  it("rejects a mismatched email — the check most important not to skip", async () => {
    const owner = await makeUser();
    const ws = await workspaces.createTeamWorkspace(owner, "Acme");
    const attacker = await makeUser("attacker@example.com");

    const { token } = await invitations.createInvitation(ws.id, owner, "intended@example.com", "member");

    await assert.rejects(
      () => invitations.acceptInvitation(token, { id: attacker, email: "attacker@example.com" }),
      (error: unknown) => {
        assert.ok(error instanceof InvitationError);
        assert.equal(error.reason, "email_mismatch");
        return true;
      },
    );

    // The token is still unused — the rejection did not consume it.
    const stillPending = await invitations.previewInvitation(token);
    assert.equal(stillPending?.valid, true);
  });

  it("rejects a second accept of the same token", async () => {
    const owner = await makeUser();
    const ws = await workspaces.createTeamWorkspace(owner, "Acme");
    const invitee = await makeUser("invitee2@example.com");

    const { token } = await invitations.createInvitation(ws.id, owner, "invitee2@example.com", "member");
    await invitations.acceptInvitation(token, { id: invitee, email: "invitee2@example.com" });

    // A second attempt to redeem the same (now-consumed) token — even the
    // real invitee trying again, not just an attacker, must be rejected.
    await assert.rejects(
      () => invitations.acceptInvitation(token, { id: invitee, email: "invitee2@example.com" }),
      (error: unknown) => {
        assert.ok(error instanceof InvitationError);
        assert.equal(error.reason, "already_accepted");
        return true;
      },
    );
  });

  it("rejects an accept after revocation", async () => {
    const owner = await makeUser();
    const ws = await workspaces.createTeamWorkspace(owner, "Acme");
    const invitee = await makeUser("revoked-target@example.com");

    const { invitation, token } = await invitations.createInvitation(
      ws.id,
      owner,
      "revoked-target@example.com",
      "member",
    );
    await invitations.revokeInvitation(ws.id, invitation.id);

    await assert.rejects(
      () =>
        invitations.acceptInvitation(token, { id: invitee, email: "revoked-target@example.com" }),
      (error: unknown) => {
        assert.ok(error instanceof InvitationError);
        assert.equal(error.reason, "revoked");
        return true;
      },
    );
  });

  it("rejects an accept after expiry", async () => {
    const owner = await makeUser();
    const ws = await workspaces.createTeamWorkspace(owner, "Acme");
    const invitee = await makeUser("expired-target@example.com");

    const { invitation, token } = await invitations.createInvitation(
      ws.id,
      owner,
      "expired-target@example.com",
      "member",
    );
    // Force it into the past directly — createInvitation always sets a
    // future expiry, so this is the only way to exercise the expired path.
    await db()
      .update(workspaceInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(workspaceInvitations.id, invitation.id));

    await assert.rejects(
      () =>
        invitations.acceptInvitation(token, { id: invitee, email: "expired-target@example.com" }),
      (error: unknown) => {
        assert.ok(error instanceof InvitationError);
        assert.equal(error.reason, "expired");
        return true;
      },
    );
  });

  it("rejects accepting into a workspace the user already belongs to", async () => {
    const owner = await makeUser();
    const ws = await workspaces.createTeamWorkspace(owner, "Acme");
    const alreadyMember = await makeUser("already@example.com");

    // Join through the normal invite path first.
    const first = await invitations.createInvitation(ws.id, owner, "already@example.com", "viewer");
    await invitations.acceptInvitation(first.token, {
      id: alreadyMember,
      email: "already@example.com",
    });

    // Re-inviting an active member is rejected at creation time
    await assert.rejects(
      () => invitations.createInvitation(ws.id, owner, "already@example.com", "admin"),
      (error: unknown) => {
        assert.ok(error instanceof InvitationError);
        assert.equal(error.reason, "already_member");
        return true;
      },
    );

    // If an invitation token existed previously, attempting to accept it is also rejected
    const token = "preexisting_token_" + Date.now();
    const tokenHash = (await import("node:crypto")).createHash("sha256").update(token).digest("hex");
    await db().insert(workspaceInvitations).values({
      id: `inv_existing_${Date.now()}`,
      workspaceId: ws.id,
      email: "already@example.com",
      role: "admin",
      tokenHash,
      invitedBy: owner,
      expiresAt: new Date(Date.now() + 100000),
    });

    await assert.rejects(
      () =>
        invitations.acceptInvitation(token, {
          id: alreadyMember,
          email: "already@example.com",
        }),
      (error: unknown) => {
        assert.ok(error instanceof InvitationError);
        assert.equal(error.reason, "already_member");
        return true;
      },
    );
  });
});

describe("revokeInvitation", () => {
  it("is idempotent", async () => {
    const owner = await makeUser();
    const ws = await workspaces.createTeamWorkspace(owner, "Acme");
    const { invitation } = await invitations.createInvitation(ws.id, owner, "x@example.com", "viewer");

    await invitations.revokeInvitation(ws.id, invitation.id);
    await invitations.revokeInvitation(ws.id, invitation.id);

    const [row] = await db()
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.id, invitation.id));
    assert.ok(row?.revokedAt);
  });
});

describe("previewInvitation", () => {
  it("returns null for an unknown token", async () => {
    assert.equal(await invitations.previewInvitation("nonexistent"), null);
  });

  it("reports the reason for an invalid but real invitation, without mutating it", async () => {
    const owner = await makeUser();
    const ws = await workspaces.createTeamWorkspace(owner, "Acme");
    const { invitation, token } = await invitations.createInvitation(
      ws.id,
      owner,
      "preview@example.com",
      "viewer",
    );
    await invitations.revokeInvitation(ws.id, invitation.id);

    const preview = await invitations.previewInvitation(token);
    assert.equal(preview?.valid, false);
    assert.equal(preview?.reason, "revoked");
  });
});

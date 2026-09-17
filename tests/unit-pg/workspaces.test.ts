/**
 * The workspace domain, against real Postgres: personal workspaces,
 * team workspaces, roles, and the last-owner protection — service layer
 * only, no routes exist yet.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";

let db: typeof import("../../src/db/pg-client").getPgDb;
let users: typeof import("../../src/db/schema.pg").users;
let workspacesTable: typeof import("../../src/db/schema.pg").workspaces;
let workspaceMembers: typeof import("../../src/db/schema.pg").workspaceMembers;
let workspaces: typeof import("../../src/core/workspaces/service");
let LastOwnerError: typeof import("../../src/core/workspaces/service").LastOwnerError;

before(async () => {
  await migrate();
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  ({ users, workspaces: workspacesTable, workspaceMembers } = await import("../../src/db/schema.pg"));
  workspaces = await import("../../src/core/workspaces/service");
  ({ LastOwnerError } = workspaces);
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
  // Each test starts from a clean slate.
  await db().delete(workspacesTable);
  await db().delete(users);
  userCounter = 0;
});

describe("personal workspaces", () => {
  it("creates exactly one, owned by the user", async () => {
    const userId = await makeUser();
    const ws = await workspaces.ensurePersonalWorkspace(userId, "Ada Lovelace");

    assert.equal(ws.kind, "personal");
    assert.equal(ws.createdBy, userId);

    const membership = await workspaces.getMembership(ws.id, userId);
    assert.equal(membership?.role, "owner");
  });

  it("is idempotent: calling it again returns the same workspace", async () => {
    const userId = await makeUser();
    const first = await workspaces.ensurePersonalWorkspace(userId);
    const second = await workspaces.ensurePersonalWorkspace(userId);
    assert.equal(first.id, second.id);
  });

  it("stays exactly one under concurrent calls (the race the partial unique index guards)", async () => {
    const userId = await makeUser();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => workspaces.ensurePersonalWorkspace(userId)),
    );

    const ids = new Set(results.map((w) => w.id));
    assert.equal(ids.size, 1, `expected one workspace, got ${ids.size}: ${[...ids]}`);

    const all = await workspaces.listWorkspacesForUser(userId);
    assert.equal(all.filter((w) => w.kind === "personal").length, 1);
  });

  it("two different users each get their own", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const wsA = await workspaces.ensurePersonalWorkspace(a);
    const wsB = await workspaces.ensurePersonalWorkspace(b);

    assert.notEqual(wsA.id, wsB.id);
    assert.notEqual(wsA.slug, wsB.slug);
  });
});

describe("team workspaces", () => {
  it("creates a team workspace with the creator as owner", async () => {
    const userId = await makeUser();
    const ws = await workspaces.createTeamWorkspace(userId, "Acme Corp");

    assert.equal(ws.kind, "team");
    assert.equal(ws.name, "Acme Corp");

    const membership = await workspaces.getMembership(ws.id, userId);
    assert.equal(membership?.role, "owner");
  });

  it("rejects an empty name", async () => {
    const userId = await makeUser();
    await assert.rejects(() => workspaces.createTeamWorkspace(userId, "   "));
  });

  it("lists every workspace a user belongs to, with their role in each", async () => {
    const owner = await makeUser();
    const member = await makeUser();
    const team = await workspaces.createTeamWorkspace(owner, "Shared Team");
    const personal = await workspaces.ensurePersonalWorkspace(owner);

    const list = await workspaces.listWorkspacesForUser(owner);
    const byId = new Map(list.map((w) => [w.id, w.role]));
    assert.equal(byId.get(team.id), "owner");
    assert.equal(byId.get(personal.id), "owner");

    // A user who never joined the team sees nothing from it.
    const memberList = await workspaces.listWorkspacesForUser(member);
    assert.equal(memberList.find((w) => w.id === team.id), undefined);
  });
});

describe("last-owner protection", () => {
  it("rejects demoting the sole owner", async () => {
    const userId = await makeUser();
    const ws = await workspaces.createTeamWorkspace(userId, "Solo Owner Co");

    await assert.rejects(
      () => workspaces.updateMemberRole(ws.id, userId, "admin"),
      LastOwnerError,
    );
    // Unchanged.
    assert.equal((await workspaces.getMembership(ws.id, userId))?.role, "owner");
  });

  it("rejects removing the sole owner", async () => {
    const userId = await makeUser();
    const ws = await workspaces.createTeamWorkspace(userId, "Solo Owner Co 2");

    await assert.rejects(() => workspaces.removeMember(ws.id, userId), LastOwnerError);
    assert.notEqual(await workspaces.getMembership(ws.id, userId), null);
  });

  it("allows demoting one of several owners, then blocks demoting the last", async () => {
    const owner1 = await makeUser();
    const owner2 = await makeUser();
    const ws = await workspaces.createTeamWorkspace(owner1, "Two Owners Co");

    // Directly promote owner2 to owner (invitations that could do this land
    // in a later step; this exercises the service function itself).
    await db()
      .insert(workspaceMembers)
      .values({ workspaceId: ws.id, userId: owner2, role: "owner" });

    // Two owners: demoting one is fine.
    await workspaces.updateMemberRole(ws.id, owner1, "member");
    assert.equal((await workspaces.getMembership(ws.id, owner1))?.role, "member");

    // Now only owner2 is an owner: demoting them must fail.
    await assert.rejects(
      () => workspaces.updateMemberRole(ws.id, owner2, "viewer"),
      LastOwnerError,
    );
  });
});

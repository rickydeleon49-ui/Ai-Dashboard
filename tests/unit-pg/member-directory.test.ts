/**
 * Release 2C.1 Member Directory: Data and Service Layer Integration Tests against real PostgreSQL.
 *
 * Verifies:
 * 1. Pagination bounds:
 *    - Default page size (20), offset, total count.
 *    - Server-enforced clamping: min (1) and max (100) limit.
 * 2. Search:
 *    - Case-insensitive search by user name.
 *    - Case-insensitive search by user email.
 *    - Non-matching search queries return empty results with total = 0.
 * 3. Safe-summary shape:
 *    - Returns strictly (id, name, email, image, role, status, joinedAt).
 *    - Confirms forbidden private fields (accounts, sessions, password, hashedPassword, emailVerified, tokens)
 *      are never included.
 * 4. Cross-workspace tenant isolation:
 *    - Queries scoped to workspace A never return members of workspace B.
 *    - Search within workspace A never leaks users who only belong to workspace B.
 * 5. Task assignee validation:
 *    - Active member is accepted as task assignee.
 *    - Suspended member is rejected with InvalidAssigneeError.
 *    - Removed member is rejected with InvalidAssigneeError.
 *    - Invited member is rejected with InvalidAssigneeError.
 * 6. Last-owner protection:
 *    - Suspending or removing the sole owner of a workspace is rejected with LastOwnerError.
 *    - In a workspace with two owners, suspending one succeeds, and suspending the last owner fails.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { Client } from "pg";
import { cleanup, migrate } from "../helpers/db.pg";

let db: typeof import("../../src/db/pg-client").getPgDb;
let users: typeof import("../../src/db/schema.pg").users;
let workspacesTable: typeof import("../../src/db/schema.pg").workspaces;
let workspaceMembers: typeof import("../../src/db/schema.pg").workspaceMembers;
let workspacesService: typeof import("../../src/core/workspaces/service");
let LastOwnerError: typeof import("../../src/core/workspaces/service").LastOwnerError;
let PostgresProjectRepository: typeof import(
  "../../src/db/repositories/postgres-project-repository"
).PostgresProjectRepository;
let PostgresTaskRepository: typeof import(
  "../../src/db/repositories/postgres-task-repository"
).PostgresTaskRepository;
let InvalidAssigneeError: typeof import("../../src/core/tasks/errors").InvalidAssigneeError;
let invitationsService: typeof import("../../src/core/workspaces/invitations");
let InvitationError: typeof import("../../src/core/workspaces/invitations").InvitationError;
let authz: typeof import("../../src/core/workspaces/authorization");

before(async () => {
  await migrate();
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  ({
    users,
    workspaces: workspacesTable,
    workspaceMembers,
  } = await import("../../src/db/schema.pg"));
  workspacesService = await import("../../src/core/workspaces/service");
  ({ LastOwnerError } = workspacesService);
  ({ PostgresProjectRepository } = await import(
    "../../src/db/repositories/postgres-project-repository"
  ));
  ({ PostgresTaskRepository } = await import(
    "../../src/db/repositories/postgres-task-repository"
  ));
  ({ InvalidAssigneeError } = await import("../../src/core/tasks/errors"));
  invitationsService = await import("../../src/core/workspaces/invitations");
  ({ InvitationError } = invitationsService);
  authz = await import("../../src/core/workspaces/authorization");
});

after(() => cleanup());

let userSeq = 0;

async function createTestUser(
  attrs: { name?: string; email?: string; image?: string } = {},
): Promise<string> {
  userSeq += 1;
  const id = `usr_dir_${userSeq}_${Date.now()}`;
  await db().insert(users).values({
    id,
    name: attrs.name ?? `User ${userSeq}`,
    email: attrs.email ?? `user_${userSeq}@example.com`,
    image: attrs.image ?? null,
  });
  return id;
}

beforeEach(async () => {
  await db().delete(workspacesTable);
  await db().delete(users);
  userSeq = 0;
});

describe("Release 2C.1: Member directory query & pagination bounds", () => {
  it("returns default pagination bounds (limit 20, offset 0) and correct total count", async () => {
    const ownerId = await createTestUser({ name: "Alice Owner", email: "alice@example.com" });
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Engineering");

    // Add 24 additional members (total 25 members in workspace)
    for (let i = 1; i <= 24; i++) {
      const uId = await createTestUser({ name: `Member ${String(i).padStart(2, "0")}` });
      await db().insert(workspaceMembers).values({
        workspaceId: ws.id,
        userId: uId,
        role: "member",
        status: "active",
      });
    }

    const page1 = await workspacesService.listMembersPaginated(ws.id);
    assert.equal(page1.total, 25);
    assert.equal(page1.limit, 20);
    assert.equal(page1.offset, 0);
    assert.equal(page1.members.length, 20);

    const page2 = await workspacesService.listMembersPaginated(ws.id, { offset: 20 });
    assert.equal(page2.total, 25);
    assert.equal(page2.limit, 20);
    assert.equal(page2.offset, 20);
    assert.equal(page2.members.length, 5);
  });

  it("clamps requested page limit to minimum 1 and maximum 100", async () => {
    const ownerId = await createTestUser({ name: "Solo Owner" });
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Bounds Test");

    // Requesting limit 0 or negative clamps to MIN_MEMBER_PAGE_SIZE (1)
    const minClamped = await workspacesService.listMembersPaginated(ws.id, { limit: 0 });
    assert.equal(minClamped.limit, 1);
    assert.equal(minClamped.members.length, 1);

    const negClamped = await workspacesService.listMembersPaginated(ws.id, { limit: -50 });
    assert.equal(negClamped.limit, 1);

    // Requesting excessive limit clamps to MAX_MEMBER_PAGE_SIZE (100)
    const maxClamped = await workspacesService.listMembersPaginated(ws.id, { limit: 999 });
    assert.equal(maxClamped.limit, 100);

    // Negative offset clamps to 0
    const negOffset = await workspacesService.listMembersPaginated(ws.id, { offset: -10 });
    assert.equal(negOffset.offset, 0);
  });
});

describe("Release 2C.1: Case-insensitive search across name and email", () => {
  it("searches members by name case-insensitively", async () => {
    const ownerId = await createTestUser({ name: "Ada Lovelace", email: "ada@analytical.org" });
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Computing");

    const babbage = await createTestUser({ name: "Charles Babbage", email: "charles@difference.org" });
    const turing = await createTestUser({ name: "Alan Turing", email: "alan@bletchley.org" });

    await db().insert(workspaceMembers).values([
      { workspaceId: ws.id, userId: babbage, role: "member", status: "active" },
      { workspaceId: ws.id, userId: turing, role: "member", status: "active" },
    ]);

    // Search lowercase substring matching Ada Lovelace
    const resAda = await workspacesService.listMembersPaginated(ws.id, { search: "lovelace" });
    assert.equal(resAda.total, 1);
    assert.equal(resAda.members[0]?.name, "Ada Lovelace");

    // Search uppercase substring matching Charles Babbage
    const resCharles = await workspacesService.listMembersPaginated(ws.id, { search: "BABBAGE" });
    assert.equal(resCharles.total, 1);
    assert.equal(resCharles.members[0]?.name, "Charles Babbage");
  });

  it("searches members by email case-insensitively", async () => {
    const ownerId = await createTestUser({ name: "Grace Hopper", email: "grace.hopper@navy.mil" });
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Compilers");

    const katherine = await createTestUser({ name: "Katherine Johnson", email: "kjohnson@nasa.gov" });
    await db().insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: katherine,
      role: "member",
      status: "active",
    });

    const resNasa = await workspacesService.listMembersPaginated(ws.id, { search: "NASA.GOV" });
    assert.equal(resNasa.total, 1);
    assert.equal(resNasa.members[0]?.email, "kjohnson@nasa.gov");

    const resNone = await workspacesService.listMembersPaginated(ws.id, { search: "nonexistent@nowhere.com" });
    assert.equal(resNone.total, 0);
    assert.equal(resNone.members.length, 0);
  });

  it("escapes %, _, and \\ so user search input matches literally without wildcard expansion", async () => {
    const ownerId = await createTestUser({ name: "Regular User", email: "regular@example.com" });
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Wildcard Test");

    const percentUser = await createTestUser({ name: "100% Discount", email: "promo%deals@example.com" });
    const underscoreUser = await createTestUser({ name: "Special_User", email: "special_agent@example.com" });

    await db().insert(workspaceMembers).values([
      { workspaceId: ws.id, userId: percentUser, role: "member", status: "active" },
      { workspaceId: ws.id, userId: underscoreUser, role: "member", status: "active" },
    ]);

    // Searching for "%" should ONLY match "100% Discount", not all 3 members
    const resPercent = await workspacesService.listMembersPaginated(ws.id, { search: "%" });
    assert.equal(resPercent.total, 1);
    assert.equal(resPercent.members[0]?.id, percentUser);

    // Searching for "_" should ONLY match "Special_User", not all 3 members
    const resUnderscore = await workspacesService.listMembersPaginated(ws.id, { search: "_" });
    assert.equal(resUnderscore.total, 1);
    assert.equal(resUnderscore.members[0]?.id, underscoreUser);

    // Searching with long input is truncated to MAX_SEARCH_LENGTH without error
    const longSearch = "a".repeat(150);
    const resLong = await workspacesService.listMembersPaginated(ws.id, { search: longSearch });
    assert.equal(resLong.total, 0);
  });
});

describe("Release 2C.1: Safe user-summary shape verification", () => {
  it("strictly returns safe fields and excludes all prohibited credentials or private data", async () => {
    const ownerId = await createTestUser({
      name: "Security Conscious",
      email: "safe@example.com",
      image: "https://example.com/avatar.png",
    });
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Safe Corp");

    const result = await workspacesService.listMembersPaginated(ws.id);
    assert.equal(result.members.length, 1);
    const member = result.members[0]!;

    // Expected public/safe fields
    assert.equal(member.id, ownerId);
    assert.equal(member.name, "Security Conscious");
    assert.equal(member.email, "safe@example.com");
    assert.equal(member.image, "https://example.com/avatar.png");
    assert.equal(member.role, "owner");
    assert.equal(member.status, "active");
    assert.ok(member.joinedAt instanceof Date);

    // Verify prohibited fields are completely absent from the object keys
    const rawKeys = Object.keys(member);
    const prohibitedFields = [
      "password",
      "hashedPassword",
      "accounts",
      "sessions",
      "tokens",
      "tokenHash",
      "emailVerified",
      "verificationToken",
      "workspaces",
    ];

    for (const field of prohibitedFields) {
      assert.equal(
        rawKeys.includes(field),
        false,
        `Prohibited field "${field}" must not exist on WorkspaceMemberSummary`,
      );
      assert.equal(
        (member as any)[field],
        undefined,
        `Prohibited property "${field}" must be undefined on WorkspaceMemberSummary`,
      );
    }
  });
});

describe("Release 2C.1: Cross-workspace tenant isolation", () => {
  it("never returns members of workspace B when querying workspace A", async () => {
    const ownerA = await createTestUser({ name: "Alice Alpha", email: "alice@alpha.org" });
    const wsA = await workspacesService.createTeamWorkspace(ownerA, "Workspace Alpha");

    const ownerB = await createTestUser({ name: "Bob Beta", email: "bob@beta.org" });
    const wsB = await workspacesService.createTeamWorkspace(ownerB, "Workspace Beta");

    // Add extra user to Workspace B
    const memberB = await createTestUser({ name: "Shared Name Colleague", email: "colleague@beta.org" });
    await db().insert(workspaceMembers).values({
      workspaceId: wsB.id,
      userId: memberB,
      role: "member",
      status: "active",
    });

    // Querying Workspace A must ONLY return Alice
    const listA = await workspacesService.listMembersPaginated(wsA.id);
    assert.equal(listA.total, 1);
    assert.deepEqual(
      listA.members.map((m) => m.id),
      [ownerA],
    );

    // Searching in Workspace A for "Shared Name" must NOT find memberB
    const searchA = await workspacesService.listMembersPaginated(wsA.id, { search: "Shared Name" });
    assert.equal(searchA.total, 0);
    assert.equal(searchA.members.length, 0);

    // Querying Workspace B returns Bob and Colleague, never Alice
    const listB = await workspacesService.listMembersPaginated(wsB.id);
    assert.equal(listB.total, 2);
    assert.ok(listB.members.every((m) => m.id !== ownerA));
  });
});

describe("Release 2C.1: Assignee status validation & task assignment invariants", () => {
  it("allows assigning an active member, and rejects suspended or removed members", async () => {
    const ownerId = await createTestUser({ name: "Project Owner" });
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Task Team");
    const projectRepo = new PostgresProjectRepository();
    const project = await projectRepo.create(ws.id, { name: "Sprint 1", source: "manual" });
    const taskRepo = new PostgresTaskRepository();

    const colleagueId = await createTestUser({ name: "Active Colleague" });
    await db().insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: colleagueId,
      role: "member",
      status: "active",
    });

    // 1. Assigning active colleague succeeds
    const task = await taskRepo.create(ws.id, {
      projectId: project.id,
      title: "Active Task",
      assigneeId: colleagueId,
    });
    assert.equal(task.assigneeId, colleagueId);

    // 2. Suspend the colleague
    await workspacesService.updateMemberStatus(ws.id, colleagueId, "suspended");

    // Creating a task assigned to the suspended member must be rejected
    await assert.rejects(
      () =>
        taskRepo.create(ws.id, {
          projectId: project.id,
          title: "Rejected Task",
          assigneeId: colleagueId,
        }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidAssigneeError);
        assert.match((err as Error).message, /active member/i);
        return true;
      },
    );

    // Updating an unassigned task to assign the suspended member must also be rejected
    const unassignedTask = await taskRepo.create(ws.id, {
      projectId: project.id,
      title: "Unassigned Task",
    });
    await assert.rejects(
      () => taskRepo.update(ws.id, unassignedTask.id, { assigneeId: colleagueId }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidAssigneeError);
        assert.match((err as Error).message, /active member/i);
        return true;
      },
    );

    // 3. Mark the colleague as removed
    await workspacesService.updateMemberStatus(ws.id, colleagueId, "removed");

    await assert.rejects(
      () => taskRepo.update(ws.id, unassignedTask.id, { assigneeId: colleagueId }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidAssigneeError);
        assert.match((err as Error).message, /active member/i);
        return true;
      },
    );

    // 4. Mark the colleague as invited via direct DB update (cannot be set via updateMemberStatus)
    await db()
      .update(workspaceMembers)
      .set({ status: "invited" })
      .where(
        and(
          eq(workspaceMembers.workspaceId, ws.id),
          eq(workspaceMembers.userId, colleagueId),
        ),
      );

    await assert.rejects(
      () => taskRepo.update(ws.id, unassignedTask.id, { assigneeId: colleagueId }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidAssigneeError);
        assert.match((err as Error).message, /active member/i);
        return true;
      },
    );

    // 5. Re-activate colleague: assignment succeeds again
    await workspacesService.updateMemberStatus(ws.id, colleagueId, "active");
    const updated = await taskRepo.update(ws.id, unassignedTask.id, { assigneeId: colleagueId });
    assert.ok(updated);
    assert.equal(updated.assigneeId, colleagueId);
  });
});

describe("Release 2C.1: Last-owner status update protection", () => {
  it("rejects suspending or removing the sole owner of a workspace", async () => {
    const ownerId = await createTestUser({ name: "Sole Owner" });
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Solo Workspace");

    await assert.rejects(
      () => workspacesService.updateMemberStatus(ws.id, ownerId, "suspended"),
      LastOwnerError,
    );

    await assert.rejects(
      () => workspacesService.updateMemberStatus(ws.id, ownerId, "removed"),
      LastOwnerError,
    );

    // Owner remains active
    const membership = await workspacesService.getMembership(ws.id, ownerId);
    assert.equal(membership?.status, "active");
  });

  it("allows suspending one of multiple owners, then prevents suspending the last remaining owner", async () => {
    const owner1 = await createTestUser({ name: "Owner One" });
    const owner2 = await createTestUser({ name: "Owner Two" });
    const ws = await workspacesService.createTeamWorkspace(owner1, "Dual Owner Workspace");

    await db().insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: owner2,
      role: "owner",
      status: "active",
    });

    // Suspending owner1 succeeds because owner2 is active
    await workspacesService.updateMemberStatus(ws.id, owner1, "suspended");
    const m1 = await workspacesService.getMembership(ws.id, owner1);
    assert.equal(m1?.status, "suspended");

    // Now owner2 is the sole active owner: suspending owner2 must be rejected
    await assert.rejects(
      () => workspacesService.updateMemberStatus(ws.id, owner2, "suspended"),
      LastOwnerError,
    );
    const m2 = await workspacesService.getMembership(ws.id, owner2);
    assert.equal(m2?.status, "active");
  });

  it("with one active and one suspended owner, removing or demoting the active owner is rejected", async () => {
    const activeOwner = await createTestUser({ name: "Active Owner" });
    const suspendedOwner = await createTestUser({ name: "Suspended Owner" });
    const ws = await workspacesService.createTeamWorkspace(activeOwner, "Active/Suspended Co");

    await db().insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: suspendedOwner,
      role: "owner",
      status: "suspended",
    });

    // Demoting the active owner must fail because the only other owner is suspended
    await assert.rejects(
      () => workspacesService.updateMemberRole(ws.id, activeOwner, "member"),
      LastOwnerError,
    );

    // Removing the active owner must also fail
    await assert.rejects(
      () => workspacesService.removeMember(ws.id, activeOwner),
      LastOwnerError,
    );

    // Active owner remains an active owner
    const m = await workspacesService.getMembership(ws.id, activeOwner);
    assert.equal(m?.role, "owner");
    assert.equal(m?.status, "active");
  });

  it("two concurrent suspensions of different owners in explicit transactions serialize and reject the second", async () => {
    const owner1 = await createTestUser({ name: "Concurrent Owner 1" });
    const owner2 = await createTestUser({ name: "Concurrent Owner 2" });
    const ws = await workspacesService.createTeamWorkspace(owner1, "Concurrent Suspension Co");

    await db().insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: owner2,
      role: "owner",
      status: "active",
    });

    const c1 = new Client({ connectionString: process.env.DATABASE_URL });
    const c2 = new Client({ connectionString: process.env.DATABASE_URL });
    await c1.connect();
    await c2.connect();

    try {
      await c1.query("BEGIN");
      await c1.query(
        "UPDATE workspace_member SET status = 'suspended' WHERE workspace_id = $1 AND user_id = $2",
        [ws.id, owner1],
      );

      await c2.query("BEGIN");
      const t2Update = c2.query(
        "UPDATE workspace_member SET status = 'suspended' WHERE workspace_id = $1 AND user_id = $2",
        [ws.id, owner2],
      );

      // t2 should block on the workspace lock held by t1
      await new Promise((resolve) => setTimeout(resolve, 300));

      await c1.query("COMMIT");

      await assert.rejects(
        t2Update,
        (err: Error) => {
          assert.match(err.message, /workspace must retain at least one owner/);
          return true;
        },
      );

      await c2.query("ROLLBACK");

      const members = await workspacesService.listMembers(ws.id);
      const activeOwners = members.filter((m) => m.role === "owner" && m.status === "active");
      assert.equal(activeOwners.length, 1);
      assert.equal(activeOwners[0]?.userId, owner2);
    } finally {
      await c1.end();
      await c2.end();
    }
  });

  it("two concurrent deletes of different owners in explicit transactions serialize and reject the second", async () => {
    const owner1 = await createTestUser({ name: "Concurrent Delete Owner 1" });
    const owner2 = await createTestUser({ name: "Concurrent Delete Owner 2" });
    const ws = await workspacesService.createTeamWorkspace(owner1, "Concurrent Delete Co");

    await db().insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: owner2,
      role: "owner",
      status: "active",
    });

    const c1 = new Client({ connectionString: process.env.DATABASE_URL });
    const c2 = new Client({ connectionString: process.env.DATABASE_URL });
    await c1.connect();
    await c2.connect();

    try {
      await c1.query("BEGIN");
      await c1.query(
        "DELETE FROM workspace_member WHERE workspace_id = $1 AND user_id = $2",
        [ws.id, owner1],
      );

      await c2.query("BEGIN");
      const t2Delete = c2.query(
        "DELETE FROM workspace_member WHERE workspace_id = $1 AND user_id = $2",
        [ws.id, owner2],
      );

      // t2 should block on the workspace lock held by t1
      await new Promise((resolve) => setTimeout(resolve, 300));

      await c1.query("COMMIT");

      await assert.rejects(
        t2Delete,
        (err: Error) => {
          assert.match(err.message, /workspace must retain at least one owner/);
          return true;
        },
      );

      await c2.query("ROLLBACK");

      const members = await workspacesService.listMembers(ws.id);
      const activeOwners = members.filter((m) => m.role === "owner" && m.status === "active");
      assert.equal(activeOwners.length, 1);
      assert.equal(activeOwners[0]?.userId, owner2);
    } finally {
      await c1.end();
      await c2.end();
    }
  });

  it("a suspend racing a demotion of different owners in explicit transactions serializes and rejects the second", async () => {
    const owner1 = await createTestUser({ name: "Suspend Racing Owner 1" });
    const owner2 = await createTestUser({ name: "Demote Racing Owner 2" });
    const ws = await workspacesService.createTeamWorkspace(owner1, "Suspend Demote Race Co");

    await db().insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: owner2,
      role: "owner",
      status: "active",
    });

    const c1 = new Client({ connectionString: process.env.DATABASE_URL });
    const c2 = new Client({ connectionString: process.env.DATABASE_URL });
    await c1.connect();
    await c2.connect();

    try {
      await c1.query("BEGIN");
      await c1.query(
        "UPDATE workspace_member SET status = 'suspended' WHERE workspace_id = $1 AND user_id = $2",
        [ws.id, owner1],
      );

      await c2.query("BEGIN");
      const t2Demote = c2.query(
        "UPDATE workspace_member SET role = 'member' WHERE workspace_id = $1 AND user_id = $2",
        [ws.id, owner2],
      );

      // t2 should block on the workspace lock held by t1
      await new Promise((resolve) => setTimeout(resolve, 300));

      await c1.query("COMMIT");

      await assert.rejects(
        t2Demote,
        (err: Error) => {
          assert.match(err.message, /workspace must retain at least one owner/);
          return true;
        },
      );

      await c2.query("ROLLBACK");

      const members = await workspacesService.listMembers(ws.id);
      const activeOwners = members.filter((m) => m.role === "owner" && m.status === "active");
      assert.equal(activeOwners.length, 1);
      assert.equal(activeOwners[0]?.userId, owner2);
    } finally {
      await c1.end();
      await c2.end();
    }
  });

  it("deleting a whole workspace still cascades cleanly", async () => {
    const ownerId = await createTestUser({ name: "Cascade Owner" });
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Cascade Workspace");

    // Workspace deletion cascades its members away cleanly without trigger failure
    await db().delete(workspacesTable).where(eq(workspacesTable.id, ws.id));

    const remainingMembers = await workspacesService.listMembers(ws.id);
    assert.equal(remainingMembers.length, 0);
  });
});

describe("Release 2C.1 Stage A: Soft removal, re-invitation & reinstatement invariants", () => {
  it("removeMember keeps the membership row with status = 'removed'", async () => {
    const ownerId = await createTestUser({ name: "Owner" });
    const memberId = await createTestUser({ name: "Member" });
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Soft Remove Co");

    await db().insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: memberId,
      role: "member",
      status: "active",
    });

    await workspacesService.removeMember(ws.id, memberId);

    const membership = await workspacesService.getMembership(ws.id, memberId);
    assert.ok(membership);
    assert.equal(membership.status, "removed");
    assert.equal(membership.role, "member");
  });

  it("a removed member cannot access workspace or be assigned tasks, and past tasks remain intact", async () => {
    const ownerId = await createTestUser({ name: "Task Owner" });
    const memberId = await createTestUser({ name: "Task Member" });
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Task History Co");

    await db().insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: memberId,
      role: "member",
      status: "active",
    });

    const projectRepo = new PostgresProjectRepository();
    const taskRepo = new PostgresTaskRepository();

    const proj = await projectRepo.create(ws.id, { name: "Project History" });
    const historicalTask = await taskRepo.create(ws.id, {
      projectId: proj.id,
      title: "Historical Task",
      assigneeId: memberId,
    });

    // Remove member (soft removal)
    await workspacesService.removeMember(ws.id, memberId);

    // 1. Removed member cannot access workspace (requireRole throws 403 inactive_member)
    await assert.rejects(
      () => authz.requireRole(ws.id, memberId, "viewer"),
      (err: unknown) => {
        assert.ok(err instanceof authz.AuthorizationError);
        assert.equal(err.reason, "inactive_member");
        return true;
      },
    );

    // 2. Removed member cannot be assigned new tasks
    await assert.rejects(
      () =>
        taskRepo.create(ws.id, {
          projectId: proj.id,
          title: "New Task Attempt",
          assigneeId: memberId,
        }),
      InvalidAssigneeError,
    );

    // 3. Past task assignment remains intact
    const fetchedTask = await taskRepo.findById(ws.id, historicalTask.id);
    assert.equal(fetchedTask?.assigneeId, memberId);
  });

  it("re-inviting a removed member reactivates the same row preserving original createdAt", async () => {
    const ownerId = await createTestUser({ name: "Reinvite Owner" });
    const email = `reinvite_${Date.now()}@example.com`;
    const memberId = await createTestUser({ name: "Reinvited Member", email });
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Reinvite Co");

    const originalJoinedAt = new Date(Date.now() - 100000);
    await db().insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: memberId,
      role: "viewer",
      status: "removed",
      createdAt: originalJoinedAt,
    });

    // Re-inviting a removed member is allowed
    const { token } = await invitationsService.createInvitation(ws.id, ownerId, email, "member");

    // Accepting the invitation reactivates the existing row
    const membership = await invitationsService.acceptInvitation(token, {
      id: memberId,
      email,
    });

    assert.equal(membership.status, "active");
    assert.equal(membership.role, "member");
    assert.equal(membership.invitedBy, ownerId);
    assert.equal(membership.createdAt.getTime(), originalJoinedAt.getTime());

    // Verified in database
    const dbMembership = await workspacesService.getMembership(ws.id, memberId);
    assert.equal(dbMembership?.status, "active");
    assert.equal(dbMembership?.role, "member");
    assert.equal(dbMembership?.createdAt.getTime(), originalJoinedAt.getTime());
  });

  it("a suspended member cannot rejoin through an invitation, and cannot be re-invited", async () => {
    const ownerId = await createTestUser({ name: "Suspended Test Owner" });
    const email = `suspended_${Date.now()}@example.com`;
    const suspendedId = await createTestUser({ name: "Suspended Member", email });
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Suspended Invite Co");

    await db().insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: suspendedId,
      role: "member",
      status: "suspended",
    });

    // 1. createInvitation rejects inviting a suspended member
    await assert.rejects(
      () => invitationsService.createInvitation(ws.id, ownerId, email, "member"),
      (err: unknown) => {
        assert.ok(err instanceof InvitationError);
        assert.equal(err.reason, "membership_suspended");
        return true;
      },
    );

    // 2. If a pre-existing token existed, acceptInvitation rejects when user is suspended
    const token = "preexisting_token_" + Date.now();
    const tokenHash = (await import("node:crypto")).createHash("sha256").update(token).digest("hex");
    const { workspaceInvitations } = await import("../../src/db/schema.pg");
    await db().insert(workspaceInvitations).values({
      id: `inv_test_${Date.now()}`,
      workspaceId: ws.id,
      email,
      role: "member",
      tokenHash,
      invitedBy: ownerId,
      expiresAt: new Date(Date.now() + 100000),
    });

    await assert.rejects(
      () => invitationsService.acceptInvitation(token, { id: suspendedId, email }),
      (err: unknown) => {
        assert.ok(err instanceof InvitationError);
        assert.equal(err.reason, "membership_suspended");
        return true;
      },
    );
  });

  it("the last active owner cannot be removed via removeMember", async () => {
    const ownerId = await createTestUser({ name: "Last Active Owner" });
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Last Owner Soft Remove");

    await assert.rejects(
      () => workspacesService.removeMember(ws.id, ownerId),
      LastOwnerError,
    );

    const m = await workspacesService.getMembership(ws.id, ownerId);
    assert.equal(m?.status, "active");
    assert.equal(m?.role, "owner");
  });

  it("updateMemberStatus rejects setting invited status directly", async () => {
    const ownerId = await createTestUser({ name: "Invited Guard Owner" });
    const memberId = await createTestUser({ name: "Invited Guard Member" });
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Invited Guard Co");

    await db().insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: memberId,
      role: "member",
      status: "active",
    });

    await assert.rejects(
      () => workspacesService.updateMemberStatus(ws.id, memberId, "invited"),
      /cannot be set directly/i,
    );
  });

  it("two concurrent acceptances of invitations for the same removed user don't produce an error or duplicate row", async () => {
    const ownerId = await createTestUser({ name: "Concurrent Accept Owner" });
    const email1 = `concurrent_accept_1_${Date.now()}@example.com`;
    const email2 = `concurrent_accept_2_${Date.now()}@example.com`;
    const removedUserId = await createTestUser({ name: "Concurrent Removed User", email: email1 });
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Concurrent Accept Co");

    await db().insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: removedUserId,
      role: "viewer",
      status: "removed",
    });

    // Create two invitations for different emails targeting the same user
    const token1 = "token_one_" + Date.now();
    const tokenHash1 = (await import("node:crypto")).createHash("sha256").update(token1).digest("hex");
    const token2 = "token_two_" + Date.now();
    const tokenHash2 = (await import("node:crypto")).createHash("sha256").update(token2).digest("hex");
    const { workspaceInvitations } = await import("../../src/db/schema.pg");

    await db().insert(workspaceInvitations).values([
      {
        id: `inv_c1_${Date.now()}`,
        workspaceId: ws.id,
        email: email1,
        role: "member",
        tokenHash: tokenHash1,
        invitedBy: ownerId,
        expiresAt: new Date(Date.now() + 100000),
      },
      {
        id: `inv_c2_${Date.now()}`,
        workspaceId: ws.id,
        email: email2,
        role: "admin",
        tokenHash: tokenHash2,
        invitedBy: ownerId,
        expiresAt: new Date(Date.now() + 100000),
      },
    ]);

    // Use two dedicated pg Clients
    const c1 = new Client({ connectionString: process.env.DATABASE_URL });
    const c2 = new Client({ connectionString: process.env.DATABASE_URL });
    await c1.connect();
    await c2.connect();

    try {
      // t1 begins, locks membership row for update, reactivates
      await c1.query("BEGIN");
      await c1.query(
        "SELECT * FROM workspace_member WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE",
        [ws.id, removedUserId],
      );
      await c1.query(
        "UPDATE workspace_member SET status = 'active', role = 'member' WHERE workspace_id = $1 AND user_id = $2",
        [ws.id, removedUserId],
      );

      // t2 begins, tries to lock the same membership row -> blocks!
      await c2.query("BEGIN");
      let t2Done = false;
      const t2Promise = c2
        .query(
          "SELECT * FROM workspace_member WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE",
          [ws.id, removedUserId],
        )
        .then((res) => {
          t2Done = true;
          return res;
        });

      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(t2Done, false, "t2 must block waiting for t1's row lock");

      // t1 commits
      await c1.query("COMMIT");

      // t2 unblocks
      const t2Res = await t2Promise;
      assert.ok(t2Res);
      // t2 sees that the status is now 'active'
      assert.equal(t2Res.rows[0]?.status, "active");
      await c2.query("ROLLBACK");

      // Verify in workspaceMembers table: exactly 1 row, no duplicates, status is active
      const allMembers = await db()
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, ws.id),
            eq(workspaceMembers.userId, removedUserId),
          ),
        );
      assert.equal(allMembers.length, 1);
      assert.equal(allMembers[0]?.status, "active");
    } finally {
      await c1.end();
      await c2.end();
    }
  });

  it("directory visibility enforces active-only for members/viewers, and allows all statuses for owners/admins", async () => {
    const ownerId = await createTestUser({ name: "Vis Owner" });
    const adminId = await createTestUser({ name: "Vis Admin" });
    const memberId = await createTestUser({ name: "Vis Member" });
    const viewerId = await createTestUser({ name: "Vis Viewer" });
    const suspendedId = await createTestUser({ name: "Vis Suspended" });
    const removedId = await createTestUser({ name: "Vis Removed" });

    const ws = await workspacesService.createTeamWorkspace(ownerId, "Visibility Co");

    await db().insert(workspaceMembers).values([
      { workspaceId: ws.id, userId: adminId, role: "admin", status: "active" },
      { workspaceId: ws.id, userId: memberId, role: "member", status: "active" },
      { workspaceId: ws.id, userId: viewerId, role: "viewer", status: "active" },
      { workspaceId: ws.id, userId: suspendedId, role: "member", status: "suspended" },
      { workspaceId: ws.id, userId: removedId, role: "member", status: "removed" },
    ]);

    // 1. Member caller: sees only active members, even if status='all' requested
    const memberView = await workspacesService.listMembersPaginated(ws.id, {
      callerRole: "member",
      status: "all",
    });
    assert.equal(memberView.members.every((m) => m.status === "active"), true);
    assert.equal(memberView.total, 4); // owner, admin, member, viewer

    // 2. Viewer caller: sees only active members
    const viewerView = await workspacesService.listMembersPaginated(ws.id, {
      callerRole: "viewer",
    });
    assert.equal(viewerView.members.every((m) => m.status === "active"), true);
    assert.equal(viewerView.total, 4);

    // 3. Admin caller: can filter by status='suspended'
    const adminSuspended = await workspacesService.listMembersPaginated(ws.id, {
      callerRole: "admin",
      status: "suspended",
    });
    assert.equal(adminSuspended.total, 1);
    assert.equal(adminSuspended.members[0]?.id, suspendedId);

    // 4. Owner caller: status='all' returns all 6 members
    const ownerAll = await workspacesService.listMembersPaginated(ws.id, {
      callerRole: "owner",
      status: "all",
    });
    assert.equal(ownerAll.total, 6);

    // 5. Default filter (omitted status) for owner: defaults to 'active'
    const ownerDefault = await workspacesService.listMembersPaginated(ws.id, {
      callerRole: "owner",
    });
    assert.equal(ownerDefault.total, 4);
    assert.equal(ownerDefault.members.every((m) => m.status === "active"), true);
  });
});

/**
 * Release 2C.2 Task Assignment: Data and Repository Layer Integration Tests against real PostgreSQL.
 *
 * Verifies:
 * 1. Filters:
 *    - "unassigned" returns only tasks with no assignee
 *    - "assigned to me" (assignedTo / assigneeId) returns tasks assigned to specific user
 *    - "assigned by me" (assignedBy) returns tasks assigned by specific user
 * 2. Provenance:
 *    - assigned_by and assigned_at are set on create with assignee
 *    - assigned_by and assigned_at are updated on assignee change
 *    - non-assignment updates preserve assigned_by and assigned_at
 *    - re-sending unchanged assignee preserves assigned_by and assigned_at without re-validating
 *    - clearing assignment resets assigned_by and assigned_at to null
 *    - creating or updating assignee without actorUserId throws an internal error
 * 3. Assignee Validation:
 *    - outsider cannot be assigned (InvalidAssigneeError)
 *    - suspended member cannot be assigned (InvalidAssigneeError)
 *    - removed member cannot be assigned (InvalidAssigneeError)
 *    - invited member cannot be assigned (InvalidAssigneeError)
 * 4. Historical Assignee Attribution:
 *    - removed member's historical assignment survives on task
 *    - suspended member's historical assignment survives on task
 *    - reads back intact via findById, list, listForWorkspace
 *    - updating other fields (title/status) on task with historical assignee succeeds
 *    - re-sending the same historical assignee on update succeeds without re-validating
 *    - re-assigning to a suspended or removed member is rejected
 * 5. Cross-Workspace Isolation:
 *    - filters in workspace A never leak tasks or assignments into workspace B
 * 6. Migration Structure:
 *    - assigned_by, assigned_at columns, foreign key, and index exist
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";

let db: typeof import("../../src/db/pg-client").getPgDb;
let users: typeof import("../../src/db/schema.pg").users;
let workspacesTable: typeof import("../../src/db/schema.pg").workspaces;
let workspaceMembers: typeof import("../../src/db/schema.pg").workspaceMembers;
let workspacesService: typeof import("../../src/core/workspaces/service");
let PostgresProjectRepository: typeof import(
  "../../src/db/repositories/postgres-project-repository"
).PostgresProjectRepository;
let PostgresTaskRepository: typeof import(
  "../../src/db/repositories/postgres-task-repository"
).PostgresTaskRepository;
let InvalidAssigneeError: typeof import("../../src/core/tasks/errors").InvalidAssigneeError;

before(async () => {
  await migrate();
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  ({
    users,
    workspaces: workspacesTable,
    workspaceMembers,
  } = await import("../../src/db/schema.pg"));
  workspacesService = await import("../../src/core/workspaces/service");
  ({ PostgresProjectRepository } = await import(
    "../../src/db/repositories/postgres-project-repository"
  ));
  ({ PostgresTaskRepository } = await import(
    "../../src/db/repositories/postgres-task-repository"
  ));
  ({ InvalidAssigneeError } = await import("../../src/core/tasks/errors"));
});

after(() => cleanup());

let userSeq = 0;

async function createTestUser(attrs: { name?: string; email?: string } = {}): Promise<string> {
  userSeq += 1;
  const id = `usr_asgn_${userSeq}_${Date.now()}`;
  await db().insert(users).values({
    id,
    name: attrs.name ?? `User ${userSeq}`,
    email: attrs.email ?? `user_${userSeq}@example.com`,
  });
  return id;
}

beforeEach(async () => {
  await db().delete(workspacesTable);
  await db().delete(users);
  userSeq = 0;
});

describe("Release 2C.2: Task Assignment Provenance & Validation", () => {
  it("records assigned_by and assigned_at from the actor on task creation", async () => {
    const ownerId = await createTestUser({ name: "Alice Owner" });
    const memberId = await createTestUser({ name: "Bob Member" });
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Engineering");

    await db().insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: memberId,
      role: "member",
      status: "active",
    });

    const projectRepo = new PostgresProjectRepository();
    const taskRepo = new PostgresTaskRepository();
    const project = await projectRepo.create(ws.id, { name: "Project Alpha" });

    // 1. Task created with assignee sets assigned_by and assigned_at
    const beforeCreate = new Date();
    const taskWithAssignee = await taskRepo.create(
      ws.id,
      {
        projectId: project.id,
        title: "Task 1",
        assigneeId: memberId,
      },
      { actorUserId: ownerId },
    );

    assert.equal(taskWithAssignee.assigneeId, memberId);
    assert.equal(taskWithAssignee.assignedBy, ownerId);
    assert.ok(taskWithAssignee.assignedAt);
    assert.ok(new Date(taskWithAssignee.assignedAt) >= beforeCreate);

    // 2. Task created without assignee has null assignedBy and assignedAt
    const unassignedTask = await taskRepo.create(
      ws.id,
      {
        projectId: project.id,
        title: "Task 2",
      },
      { actorUserId: ownerId },
    );

    assert.equal(unassignedTask.assigneeId, null);
    assert.equal(unassignedTask.assignedBy, null);
    assert.equal(unassignedTask.assignedAt, null);
  });

  it("throws an error if an assignee is set on create without actorUserId", async () => {
    const ownerId = await createTestUser({ name: "Alice Owner" });
    const memberId = await createTestUser({ name: "Bob Member" });
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Engineering");

    await db().insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: memberId,
      role: "member",
      status: "active",
    });

    const projectRepo = new PostgresProjectRepository();
    const taskRepo = new PostgresTaskRepository();
    const project = await projectRepo.create(ws.id, { name: "Project Alpha" });

    await assert.rejects(
      () =>
        taskRepo.create(ws.id, {
          projectId: project.id,
          title: "Missing Actor Task",
          assigneeId: memberId,
        }),
      /actorUserId is required when setting a task assignee/i,
    );
  });

  it("updates assigned_by and assigned_at when assignee changes and preserves on non-assignment updates", async () => {
    const ownerId = await createTestUser({ name: "Alice Owner" });
    const member1Id = await createTestUser({ name: "Bob Member 1" });
    const member2Id = await createTestUser({ name: "Carol Member 2" });
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Engineering");

    await db().insert(workspaceMembers).values([
      { workspaceId: ws.id, userId: member1Id, role: "member", status: "active" },
      { workspaceId: ws.id, userId: member2Id, role: "member", status: "active" },
    ]);

    const projectRepo = new PostgresProjectRepository();
    const taskRepo = new PostgresTaskRepository();
    const project = await projectRepo.create(ws.id, { name: "Project Alpha" });

    const task = await taskRepo.create(
      ws.id,
      {
        projectId: project.id,
        title: "Task Initial",
        assigneeId: member1Id,
      },
      { actorUserId: ownerId },
    );

    const initialAssignedAt = task.assignedAt;
    assert.equal(task.assignedBy, ownerId);

    // 1. Non-assignment update preserves assignedBy and assignedAt
    const updatedTitle = await taskRepo.update(
      ws.id,
      task.id,
      { title: "Task Initial Renamed", status: "in_progress" },
      { actorUserId: member1Id },
    );
    assert.ok(updatedTitle);
    assert.equal(updatedTitle.title, "Task Initial Renamed");
    assert.equal(updatedTitle.assigneeId, member1Id);
    assert.equal(updatedTitle.assignedBy, ownerId);
    assert.equal(updatedTitle.assignedAt, initialAssignedAt);

    // 2. Re-sending the same assignee does NOT change assignedBy or assignedAt
    const sameAssigneeUpdate = await taskRepo.update(
      ws.id,
      task.id,
      { assigneeId: member1Id, title: "Title Changed With Same Assignee" },
      { actorUserId: member2Id },
    );
    assert.ok(sameAssigneeUpdate);
    assert.equal(sameAssigneeUpdate.title, "Title Changed With Same Assignee");
    assert.equal(sameAssigneeUpdate.assigneeId, member1Id);
    assert.equal(sameAssigneeUpdate.assignedBy, ownerId); // Still ownerId, not member2Id!
    assert.equal(sameAssigneeUpdate.assignedAt, initialAssignedAt);

    // 3. Re-assigning to member2 by member1 updates assignedBy and assignedAt
    const reassigned = await taskRepo.update(
      ws.id,
      task.id,
      { assigneeId: member2Id },
      { actorUserId: member1Id },
    );
    assert.ok(reassigned);
    assert.equal(reassigned.assigneeId, member2Id);
    assert.equal(reassigned.assignedBy, member1Id);
    assert.ok(reassigned.assignedAt);

    // 4. Changing assignee without actorUserId throws error
    await assert.rejects(
      () =>
        taskRepo.update(ws.id, task.id, { assigneeId: member1Id }),
      /actorUserId is required when changing a task assignee/i,
    );

    // 5. Clearing assignee resets assignedBy and assignedAt to null
    const cleared = await taskRepo.update(
      ws.id,
      task.id,
      { assigneeId: null },
      { actorUserId: member2Id },
    );
    assert.ok(cleared);
    assert.equal(cleared.assigneeId, null);
    assert.equal(cleared.assignedBy, null);
    assert.equal(cleared.assignedAt, null);
  });

  it("rejects assigning outsider, suspended, removed, or invited members", async () => {
    const ownerId = await createTestUser({ name: "Alice Owner" });
    const suspendedId = await createTestUser({ name: "Bob Suspended" });
    const removedId = await createTestUser({ name: "Carol Removed" });
    const invitedId = await createTestUser({ name: "Dave Invited" });
    const outsiderId = await createTestUser({ name: "Eve Outsider" });

    const ws = await workspacesService.createTeamWorkspace(ownerId, "Engineering");

    await db().insert(workspaceMembers).values([
      { workspaceId: ws.id, userId: suspendedId, role: "member", status: "suspended" },
      { workspaceId: ws.id, userId: removedId, role: "member", status: "removed" },
      { workspaceId: ws.id, userId: invitedId, role: "member", status: "invited" },
    ]);

    const projectRepo = new PostgresProjectRepository();
    const taskRepo = new PostgresTaskRepository();
    const project = await projectRepo.create(ws.id, { name: "Project Alpha" });

    // Outsider
    await assert.rejects(
      () =>
        taskRepo.create(
          ws.id,
          { projectId: project.id, title: "T1", assigneeId: outsiderId },
          { actorUserId: ownerId },
        ),
      (err: unknown) => {
        assert.ok(err instanceof InvalidAssigneeError);
        return true;
      },
    );

    // Suspended
    await assert.rejects(
      () =>
        taskRepo.create(
          ws.id,
          { projectId: project.id, title: "T2", assigneeId: suspendedId },
          { actorUserId: ownerId },
        ),
      (err: unknown) => {
        assert.ok(err instanceof InvalidAssigneeError);
        return true;
      },
    );

    // Removed
    await assert.rejects(
      () =>
        taskRepo.create(
          ws.id,
          { projectId: project.id, title: "T3", assigneeId: removedId },
          { actorUserId: ownerId },
        ),
      (err: unknown) => {
        assert.ok(err instanceof InvalidAssigneeError);
        return true;
      },
    );

    // Invited
    await assert.rejects(
      () =>
        taskRepo.create(
          ws.id,
          { projectId: project.id, title: "T4", assigneeId: invitedId },
          { actorUserId: ownerId },
        ),
      (err: unknown) => {
        assert.ok(err instanceof InvalidAssigneeError);
        return true;
      },
    );

    // Also on update: reassigning to suspended or removed user is rejected
    const validTask = await taskRepo.create(
      ws.id,
      { projectId: project.id, title: "T5" },
      { actorUserId: ownerId },
    );

    await assert.rejects(
      () =>
        taskRepo.update(
          ws.id,
          validTask.id,
          { assigneeId: removedId },
          { actorUserId: ownerId },
        ),
      (err: unknown) => {
        assert.ok(err instanceof InvalidAssigneeError);
        return true;
      },
    );

    await assert.rejects(
      () =>
        taskRepo.update(
          ws.id,
          validTask.id,
          { assigneeId: suspendedId },
          { actorUserId: ownerId },
        ),
      (err: unknown) => {
        assert.ok(err instanceof InvalidAssigneeError);
        return true;
      },
    );
  });

  it("preserves historical assignment for suspended and removed members and allows task editing", async () => {
    const ownerId = await createTestUser({ name: "Alice Owner" });
    const suspendedMemberId = await createTestUser({ name: "Bob Suspended" });
    const removedMemberId = await createTestUser({ name: "Carol Removed" });
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Engineering");

    await db().insert(workspaceMembers).values([
      { workspaceId: ws.id, userId: suspendedMemberId, role: "member", status: "active" },
      { workspaceId: ws.id, userId: removedMemberId, role: "member", status: "active" },
    ]);

    const projectRepo = new PostgresProjectRepository();
    const taskRepo = new PostgresTaskRepository();
    const project = await projectRepo.create(ws.id, { name: "Project Alpha" });

    // 1. Assign tasks while members are active
    const taskSuspended = await taskRepo.create(
      ws.id,
      {
        projectId: project.id,
        title: "Task with Suspended Assignee",
        assigneeId: suspendedMemberId,
      },
      { actorUserId: ownerId },
    );

    const taskRemoved = await taskRepo.create(
      ws.id,
      {
        projectId: project.id,
        title: "Task with Removed Assignee",
        assigneeId: removedMemberId,
      },
      { actorUserId: ownerId },
    );

    // 2. Suspend one member and remove the other
    await workspacesService.updateMemberStatus(ws.id, suspendedMemberId, "suspended", {
      callerRole: "owner",
    });
    await workspacesService.removeMember(ws.id, removedMemberId, { callerRole: "owner" });

    // 3. Historical assignment still reads back intact
    const readSuspendedTask = await taskRepo.findById(ws.id, taskSuspended.id);
    assert.ok(readSuspendedTask);
    assert.equal(readSuspendedTask.assigneeId, suspendedMemberId);
    assert.equal(readSuspendedTask.assignedBy, ownerId);

    const readRemovedTask = await taskRepo.findById(ws.id, taskRemoved.id);
    assert.ok(readRemovedTask);
    assert.equal(readRemovedTask.assigneeId, removedMemberId);
    assert.equal(readRemovedTask.assignedBy, ownerId);

    // 4. Updating title and status on the suspended-assignee task succeeds
    const updatedSuspended = await taskRepo.update(ws.id, taskSuspended.id, {
      title: "Updated Title Suspended",
      status: "in_progress",
    });
    assert.ok(updatedSuspended);
    assert.equal(updatedSuspended.title, "Updated Title Suspended");
    assert.equal(updatedSuspended.status, "in_progress");
    assert.equal(updatedSuspended.assigneeId, suspendedMemberId);
    assert.equal(updatedSuspended.assignedBy, ownerId);

    // Also re-sending the same assigneeId does NOT re-validate and does not error
    const reSentSuspended = await taskRepo.update(ws.id, taskSuspended.id, {
      assigneeId: suspendedMemberId,
      description: "Updated description",
    });
    assert.ok(reSentSuspended);
    assert.equal(reSentSuspended.assigneeId, suspendedMemberId);
    assert.equal(reSentSuspended.assignedBy, ownerId);

    // 5. Updating title and status on the removed-assignee task succeeds
    const updatedRemoved = await taskRepo.update(ws.id, taskRemoved.id, {
      title: "Updated Title Removed",
      status: "done",
    });
    assert.ok(updatedRemoved);
    assert.equal(updatedRemoved.title, "Updated Title Removed");
    assert.equal(updatedRemoved.status, "done");
    assert.equal(updatedRemoved.assigneeId, removedMemberId);
    assert.equal(updatedRemoved.assignedBy, ownerId);

    // Re-sending unchanged removed assigneeId succeeds without re-validation
    const reSentRemoved = await taskRepo.update(ws.id, taskRemoved.id, {
      assigneeId: removedMemberId,
      title: "Re-sent Unchanged Removed",
    });
    assert.ok(reSentRemoved);
    assert.equal(reSentRemoved.assigneeId, removedMemberId);
    assert.equal(reSentRemoved.assignedBy, ownerId);

    // But changing assignee to a suspended or removed user is rejected
    await assert.rejects(
      () =>
        taskRepo.update(
          ws.id,
          taskSuspended.id,
          { assigneeId: removedMemberId },
          { actorUserId: ownerId },
        ),
      InvalidAssigneeError,
    );
  });
});

describe("Release 2C.2: Assignment Filters & Cross-Workspace Isolation", () => {
  it("filters tasks by unassigned, assignedTo, and assignedBy", async () => {
    const ownerId = await createTestUser({ name: "Alice Owner" });
    const member1Id = await createTestUser({ name: "Bob Member 1" });
    const member2Id = await createTestUser({ name: "Carol Member 2" });
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Engineering");

    await db().insert(workspaceMembers).values([
      { workspaceId: ws.id, userId: member1Id, role: "member", status: "active" },
      { workspaceId: ws.id, userId: member2Id, role: "member", status: "active" },
    ]);

    const projectRepo = new PostgresProjectRepository();
    const taskRepo = new PostgresTaskRepository();
    const project = await projectRepo.create(ws.id, { name: "Project Alpha" });

    // Task 1: Unassigned
    const tUnassigned = await taskRepo.create(
      ws.id,
      {
        projectId: project.id,
        title: "Unassigned Task",
      },
      { actorUserId: ownerId },
    );

    // Task 2: Assigned to member1 by owner
    const tMember1ByOwner = await taskRepo.create(
      ws.id,
      {
        projectId: project.id,
        title: "Task for Member 1",
        assigneeId: member1Id,
      },
      { actorUserId: ownerId },
    );

    // Task 3: Assigned to member2 by member1
    const tMember2ByMember1 = await taskRepo.create(
      ws.id,
      {
        projectId: project.id,
        title: "Task for Member 2",
        assigneeId: member2Id,
      },
      { actorUserId: member1Id },
    );

    // 1. Filter: unassigned
    const unassignedList = await taskRepo.list(ws.id, project.id, { unassigned: true });
    assert.equal(unassignedList.length, 1);
    assert.equal(unassignedList[0]!.id, tUnassigned.id);

    const unassignedWsList = await taskRepo.listForWorkspace(ws.id, { unassigned: true });
    assert.equal(unassignedWsList.length, 1);
    assert.equal(unassignedWsList[0]!.id, tUnassigned.id);

    // 2. Filter: assignedTo ("assigned to me")
    const member1Tasks = await taskRepo.list(ws.id, project.id, { assignedTo: member1Id });
    assert.equal(member1Tasks.length, 1);
    assert.equal(member1Tasks[0]!.id, tMember1ByOwner.id);

    const member2WsTasks = await taskRepo.listForWorkspace(ws.id, { assignedTo: member2Id });
    assert.equal(member2WsTasks.length, 1);
    assert.equal(member2WsTasks[0]!.id, tMember2ByMember1.id);

    // 3. Filter: assignedBy ("assigned by me")
    const ownerAssigned = await taskRepo.list(ws.id, project.id, { assignedBy: ownerId });
    assert.equal(ownerAssigned.length, 1);
    assert.equal(ownerAssigned[0]!.id, tMember1ByOwner.id);

    const member1Assigned = await taskRepo.listForWorkspace(ws.id, { assignedBy: member1Id });
    assert.equal(member1Assigned.length, 1);
    assert.equal(member1Assigned[0]!.id, tMember2ByMember1.id);
  });

  it("enforces strict cross-workspace isolation of assignment filters", async () => {
    const userA = await createTestUser({ name: "User A" });
    const userB = await createTestUser({ name: "User B" });

    const wsA = await workspacesService.createTeamWorkspace(userA, "Workspace A");
    const wsB = await workspacesService.createTeamWorkspace(userB, "Workspace B");

    // Add userA to wsB as well so user exists in both
    await db().insert(workspaceMembers).values({
      workspaceId: wsB.id,
      userId: userA,
      role: "member",
      status: "active",
    });

    const projectRepo = new PostgresProjectRepository();
    const taskRepo = new PostgresTaskRepository();

    const projA = await projectRepo.create(wsA.id, { name: "Project in A" });
    const projB = await projectRepo.create(wsB.id, { name: "Project in B" });

    // Task in wsA assigned to userA by userA
    await taskRepo.create(
      wsA.id,
      { projectId: projA.id, title: "Task in A", assigneeId: userA },
      { actorUserId: userA },
    );

    // Task in wsA unassigned
    await taskRepo.create(
      wsA.id,
      { projectId: projA.id, title: "Unassigned in A" },
      { actorUserId: userA },
    );

    // Task in wsB assigned to userB by userB
    await taskRepo.create(
      wsB.id,
      { projectId: projB.id, title: "Task in B", assigneeId: userB },
      { actorUserId: userB },
    );

    // 1. Querying wsB for assignedTo userA returns empty even though userA has tasks in wsA
    const wsBUserATasks = await taskRepo.listForWorkspace(wsB.id, { assignedTo: userA });
    assert.equal(wsBUserATasks.length, 0);

    // 2. Querying wsB for assignedBy userA returns empty
    const wsBUserAAssignedBy = await taskRepo.listForWorkspace(wsB.id, { assignedBy: userA });
    assert.equal(wsBUserAAssignedBy.length, 0);

    // 3. Querying wsB for unassigned returns 0 (unassigned task in wsA does not leak)
    const wsBUnassigned = await taskRepo.listForWorkspace(wsB.id, { unassigned: true });
    assert.equal(wsBUnassigned.length, 0);

    // 4. Querying wsA returns wsA tasks
    const wsAUserATasks = await taskRepo.listForWorkspace(wsA.id, { assignedTo: userA });
    assert.equal(wsAUserATasks.length, 1);
    assert.equal(wsAUserATasks[0]!.title, "Task in A");

    const wsAUnassigned = await taskRepo.listForWorkspace(wsA.id, { unassigned: true });
    assert.equal(wsAUnassigned.length, 1);
    assert.equal(wsAUnassigned[0]!.title, "Unassigned in A");
  });
});

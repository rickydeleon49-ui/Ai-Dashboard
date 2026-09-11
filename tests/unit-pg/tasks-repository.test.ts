/**
 * PostgresMilestoneRepository and PostgresTaskRepository, against real
 * Postgres: proves two workspaces never see each other's milestones or
 * tasks — the point of the Postgres implementation existing at all, not
 * just "does CRUD work" (behavior parity with the SQLite implementations
 * is covered by tests/unit/tasks.test.ts, which exercises the same CRUD
 * shape against a throwaway SQLite database).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";

let db: typeof import("../../src/db/pg-client").getPgDb;
let users: typeof import("../../src/db/schema.pg").users;
let workspaces: typeof import("../../src/core/workspaces/service");
let PostgresProjectRepository: typeof import(
  "../../src/db/repositories/postgres-project-repository"
).PostgresProjectRepository;
let PostgresMilestoneRepository: typeof import(
  "../../src/db/repositories/postgres-milestone-repository"
).PostgresMilestoneRepository;
let PostgresTaskRepository: typeof import(
  "../../src/db/repositories/postgres-task-repository"
).PostgresTaskRepository;

before(async () => {
  await migrate();
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  ({ users } = await import("../../src/db/schema.pg"));
  workspaces = await import("../../src/core/workspaces/service");
  ({ PostgresProjectRepository } = await import(
    "../../src/db/repositories/postgres-project-repository"
  ));
  ({ PostgresMilestoneRepository } = await import(
    "../../src/db/repositories/postgres-milestone-repository"
  ));
  ({ PostgresTaskRepository } = await import("../../src/db/repositories/postgres-task-repository"));
});

after(() => cleanup());

let userCounter = 0;

/** Creates a throwaway user, a team workspace they own, and one project in it. */
async function makeWorkspaceWithProject(
  name: string,
): Promise<{ workspaceId: string; userId: string; projectId: string }> {
  userCounter += 1;
  const userId = `user_${userCounter}_${Date.now()}`;
  await db().insert(users).values({ id: userId, email: `${userId}@example.com` });
  const ws = await workspaces.createTeamWorkspace(userId, name);
  const projects = new PostgresProjectRepository();
  const project = await projects.create(ws.id, { name: `${name} project`, source: "manual" });
  return { workspaceId: ws.id, userId, projectId: project.id };
}

describe("PostgresMilestoneRepository: CRUD + workspace isolation", () => {
  it("creates a milestone and reads it back", async () => {
    const repo = new PostgresMilestoneRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Milestone CRUD");

    const created = await repo.create(workspaceId, {
      projectId,
      title: "Launch v1",
      description: "Ship the first release",
      dueDate: "2026-12-01T00:00:00.000Z",
    });
    assert.equal(created.title, "Launch v1");
    assert.equal(created.status, "open");
    assert.equal(created.completedAt, null);

    const found = await repo.findById(workspaceId, created.id);
    assert.equal(found?.title, "Launch v1");
  });

  it("stamps completedAt when moved to completed, and clears it if reopened", async () => {
    const repo = new PostgresMilestoneRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Milestone Complete");
    const milestone = await repo.create(workspaceId, { projectId, title: "Beta" });

    const completed = await repo.update(workspaceId, milestone.id, { status: "completed" });
    assert.ok(completed?.completedAt);

    const reopened = await repo.update(workspaceId, milestone.id, { status: "open" });
    assert.equal(reopened?.completedAt, null);
  });

  it("list() never returns another workspace's milestones", async () => {
    const repo = new PostgresMilestoneRepository();
    const a = await makeWorkspaceWithProject("Milestone Isolation A");
    const b = await makeWorkspaceWithProject("Milestone Isolation B");

    await repo.create(a.workspaceId, { projectId: a.projectId, title: "A milestone" });
    await repo.create(b.workspaceId, { projectId: b.projectId, title: "B milestone" });

    const fromA = await repo.list(a.workspaceId, a.projectId);
    assert.deepEqual(
      fromA.map((m) => m.title),
      ["A milestone"],
    );
  });

  it("update and delete are no-ops from another workspace", async () => {
    const repo = new PostgresMilestoneRepository();
    const a = await makeWorkspaceWithProject("Milestone Hijack A");
    const b = await makeWorkspaceWithProject("Milestone Hijack B");

    const milestone = await repo.create(a.workspaceId, { projectId: a.projectId, title: "Original" });

    assert.equal(await repo.update(b.workspaceId, milestone.id, { title: "Hijacked" }), null);
    assert.equal((await repo.findById(a.workspaceId, milestone.id))?.title, "Original");

    assert.equal(await repo.delete(b.workspaceId, milestone.id), false);
    assert.ok(await repo.findById(a.workspaceId, milestone.id));
  });
});

describe("PostgresTaskRepository: CRUD + workspace isolation", () => {
  it("creates a task, reads it back, and can assign it to a real user", async () => {
    const repo = new PostgresTaskRepository();
    const { workspaceId, projectId, userId } = await makeWorkspaceWithProject("Task CRUD");

    const created = await repo.create(workspaceId, {
      projectId,
      title: "Write the plan",
      priority: "high",
      assigneeId: userId,
    });
    assert.equal(created.status, "todo");
    assert.equal(created.priority, "high");
    assert.equal(created.assigneeId, userId);

    const found = await repo.findById(workspaceId, created.id);
    assert.equal(found?.title, "Write the plan");
  });

  it("stamps completedAt on done/cancelled, clears it when reopened", async () => {
    const repo = new PostgresTaskRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Task Complete");
    const task = await repo.create(workspaceId, { projectId, title: "Ship it" });

    const done = await repo.update(workspaceId, task.id, { status: "done" });
    assert.ok(done?.completedAt);

    const reopened = await repo.update(workspaceId, task.id, { status: "todo" });
    assert.equal(reopened?.completedAt, null);
  });

  it("list() never returns another workspace's tasks", async () => {
    const repo = new PostgresTaskRepository();
    const a = await makeWorkspaceWithProject("Task Isolation A");
    const b = await makeWorkspaceWithProject("Task Isolation B");

    await repo.create(a.workspaceId, { projectId: a.projectId, title: "A task" });
    await repo.create(b.workspaceId, { projectId: b.projectId, title: "B task" });

    const fromA = await repo.list(a.workspaceId, a.projectId);
    assert.deepEqual(
      fromA.map((t) => t.title),
      ["A task"],
    );
  });

  it("listForWorkspace spans every project in the workspace, but never crosses into another", async () => {
    const repo = new PostgresTaskRepository();
    const projects = new PostgresProjectRepository();
    const a = await makeWorkspaceWithProject("Task Cross-Project A");
    const b = await makeWorkspaceWithProject("Task Cross-Project B");
    const secondProjectInA = await projects.create(a.workspaceId, {
      name: "Second project",
      source: "manual",
    });

    await repo.create(a.workspaceId, { projectId: a.projectId, title: "First project task" });
    await repo.create(a.workspaceId, { projectId: secondProjectInA.id, title: "Second project task" });
    await repo.create(b.workspaceId, { projectId: b.projectId, title: "B task" });

    const fromA = await repo.listForWorkspace(a.workspaceId);
    assert.deepEqual(
      fromA.map((t) => t.title).sort(),
      ["First project task", "Second project task"],
    );
  });

  it("listForWorkspace filters by assignee, scoped to the workspace", async () => {
    const repo = new PostgresTaskRepository();
    const a = await makeWorkspaceWithProject("Task Assignee A");

    await repo.create(a.workspaceId, {
      projectId: a.projectId,
      title: "Assigned to owner",
      assigneeId: a.userId,
    });
    await repo.create(a.workspaceId, { projectId: a.projectId, title: "Unassigned" });

    const assignedToOwner = await repo.listForWorkspace(a.workspaceId, { assigneeId: a.userId });
    assert.deepEqual(
      assignedToOwner.map((t) => t.title),
      ["Assigned to owner"],
    );
  });

  it("update and delete are no-ops from another workspace", async () => {
    const repo = new PostgresTaskRepository();
    const a = await makeWorkspaceWithProject("Task Hijack A");
    const b = await makeWorkspaceWithProject("Task Hijack B");

    const task = await repo.create(a.workspaceId, { projectId: a.projectId, title: "Original" });

    assert.equal(await repo.update(b.workspaceId, task.id, { title: "Hijacked" }), null);
    assert.equal((await repo.findById(a.workspaceId, task.id))?.title, "Original");

    assert.equal(await repo.delete(b.workspaceId, task.id), false);
    assert.ok(await repo.findById(a.workspaceId, task.id));
  });

  it("subtasks (parentTaskId) and milestone linkage round-trip correctly", async () => {
    const repo = new PostgresMilestoneRepository();
    const taskRepo = new PostgresTaskRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Task Hierarchy");

    const milestone = await repo.create(workspaceId, { projectId, title: "v1" });
    const parent = await taskRepo.create(workspaceId, {
      projectId,
      title: "Parent task",
      milestoneId: milestone.id,
    });
    const child = await taskRepo.create(workspaceId, {
      projectId,
      title: "Subtask",
      parentTaskId: parent.id,
    });

    const subtasks = await taskRepo.list(workspaceId, projectId, { parentTaskId: parent.id });
    assert.deepEqual(
      subtasks.map((t) => t.id),
      [child.id],
    );

    const topLevel = await taskRepo.list(workspaceId, projectId, { parentTaskId: null });
    assert.deepEqual(
      topLevel.map((t) => t.id).sort(),
      [parent.id].sort(),
    );

    assert.equal((await taskRepo.findById(workspaceId, parent.id))?.milestoneId, milestone.id);
  });
});

/**
 * Milestones and tasks against a throwaway SQLite database — desktop mode.
 * Workspace isolation (the reason a Postgres implementation exists at all)
 * is covered separately in tests/unit-pg/tasks-repository.test.ts; this
 * file exercises the CRUD shape both implementations share, plus the one
 * thing genuinely different on desktop: there is no user concept, so
 * assigneeId can never persist.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db";
import { LOCAL_WORKSPACE_ID } from "../../src/db/repositories/project-repository";

let projectRepository: import("../../src/db/repositories/project-repository").ProjectRepository;
let milestoneRepository: import("../../src/db/repositories/milestone-repository").MilestoneRepository;
let taskRepository: import("../../src/db/repositories/task-repository").TaskRepository;
let projectId: string;

before(async () => {
  await migrate();
  ({ projectRepository, milestoneRepository, taskRepository } = await import(
    "../../src/db/repositories"
  ));
  const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Test Project" });
  projectId = project.id;
});

after(() => cleanup());

describe("milestones (SQLite)", () => {
  it("creates a milestone with defaults", async () => {
    const milestone = await milestoneRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Launch v1",
    });
    assert.equal(milestone.status, "open");
    assert.equal(milestone.description, null);
    assert.equal(milestone.completedAt, null);
  });

  it("stamps completedAt when moved to completed, clears it if reopened", async () => {
    const milestone = await milestoneRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Beta",
    });

    const completed = await milestoneRepository.update(LOCAL_WORKSPACE_ID, milestone.id, {
      status: "completed",
    });
    assert.ok(completed?.completedAt);

    const reopened = await milestoneRepository.update(LOCAL_WORKSPACE_ID, milestone.id, {
      status: "open",
    });
    assert.equal(reopened?.completedAt, null);
  });

  it("lists only milestones for the given project", async () => {
    const other = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Other Project" });
    await milestoneRepository.create(LOCAL_WORKSPACE_ID, { projectId, title: "Mine" });
    await milestoneRepository.create(LOCAL_WORKSPACE_ID, { projectId: other.id, title: "Not mine" });

    const list = await milestoneRepository.list(LOCAL_WORKSPACE_ID, projectId);
    assert.ok(list.every((m) => m.title !== "Not mine"));
    assert.ok(list.some((m) => m.title === "Mine"));
  });

  it("delete removes the row; a second delete reports false", async () => {
    const milestone = await milestoneRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Temporary",
    });
    assert.equal(await milestoneRepository.delete(LOCAL_WORKSPACE_ID, milestone.id), true);
    assert.equal(await milestoneRepository.delete(LOCAL_WORKSPACE_ID, milestone.id), false);
    assert.equal(await milestoneRepository.findById(LOCAL_WORKSPACE_ID, milestone.id), null);
  });

  it("rejects a non-local workspace id", async () => {
    await assert.rejects(() => milestoneRepository.list("some-other-workspace", projectId));
  });
});

describe("tasks (SQLite)", () => {
  it("creates a task with defaults, ignoring any assigneeId", async () => {
    const task = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Write the plan",
      assigneeId: "someone", // desktop has no user concept — must be dropped, not stored
    });
    assert.equal(task.status, "todo");
    assert.equal(task.priority, "medium");
    assert.equal(task.assigneeId, null);
  });

  it("stamps completedAt on done/cancelled, clears it when reopened", async () => {
    const task = await taskRepository.create(LOCAL_WORKSPACE_ID, { projectId, title: "Ship it" });

    const done = await taskRepository.update(LOCAL_WORKSPACE_ID, task.id, { status: "done" });
    assert.ok(done?.completedAt);

    const reopened = await taskRepository.update(LOCAL_WORKSPACE_ID, task.id, { status: "todo" });
    assert.equal(reopened?.completedAt, null);
  });

  it("filters by status and priority", async () => {
    await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Urgent todo",
      priority: "urgent",
    });
    await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Low todo",
      priority: "low",
    });
    const doneTask = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Already done",
    });
    await taskRepository.update(LOCAL_WORKSPACE_ID, doneTask.id, { status: "done" });

    const urgentOnly = await taskRepository.list(LOCAL_WORKSPACE_ID, projectId, {
      priority: "urgent",
    });
    assert.ok(urgentOnly.every((t) => t.priority === "urgent"));
    assert.ok(urgentOnly.some((t) => t.title === "Urgent todo"));

    const doneOnly = await taskRepository.list(LOCAL_WORKSPACE_ID, projectId, { status: "done" });
    assert.ok(doneOnly.every((t) => t.status === "done"));
  });

  it("subtasks and milestone linkage round-trip correctly", async () => {
    const milestone = await milestoneRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "v1",
    });
    const parent = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Parent task",
      milestoneId: milestone.id,
    });
    const child = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Subtask",
      parentTaskId: parent.id,
    });

    const subtasks = await taskRepository.list(LOCAL_WORKSPACE_ID, projectId, {
      parentTaskId: parent.id,
    });
    assert.deepEqual(
      subtasks.map((t) => t.id),
      [child.id],
    );
    assert.equal((await taskRepository.findById(LOCAL_WORKSPACE_ID, parent.id))?.milestoneId, milestone.id);
  });

  it("listForWorkspace spans every project", async () => {
    const other = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Second Project" });
    await taskRepository.create(LOCAL_WORKSPACE_ID, { projectId, title: "In first project" });
    await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId: other.id,
      title: "In second project",
    });

    const all = await taskRepository.listForWorkspace(LOCAL_WORKSPACE_ID);
    assert.ok(all.some((t) => t.title === "In first project"));
    assert.ok(all.some((t) => t.title === "In second project"));
  });

  it("listForWorkspace filtered by assigneeId returns nothing — desktop has no assignees", async () => {
    await taskRepository.create(LOCAL_WORKSPACE_ID, { projectId, title: "Any task" });
    const filtered = await taskRepository.listForWorkspace(LOCAL_WORKSPACE_ID, {
      assigneeId: "anyone",
    });
    assert.deepEqual(filtered, []);
  });

  it("delete removes the row; a second delete reports false", async () => {
    const task = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Temporary",
    });
    assert.equal(await taskRepository.delete(LOCAL_WORKSPACE_ID, task.id), true);
    assert.equal(await taskRepository.delete(LOCAL_WORKSPACE_ID, task.id), false);
  });

  it("rejects a non-local workspace id", async () => {
    await assert.rejects(() => taskRepository.list("some-other-workspace", projectId));
  });
});

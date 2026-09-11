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

describe("task dependencies + blocked state (SQLite)", () => {
  async function makeTask(title: string) {
    return taskRepository.create(LOCAL_WORKSPACE_ID, { projectId, title });
  }

  it("a task with no dependencies is not blocked", async () => {
    const task = await makeTask("Solo");
    assert.equal(task.blocked, false);
  });

  it("a task becomes blocked once it depends on an unfinished task", async () => {
    const blocker = await makeTask("Blocker");
    const dependent = await makeTask("Dependent");

    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, dependent.id, blocker.id);

    const found = await taskRepository.findById(LOCAL_WORKSPACE_ID, dependent.id);
    assert.equal(found?.blocked, true);
  });

  it("unblocks once the blocking task is done, and re-blocks if reopened", async () => {
    const blocker = await makeTask("Blocker 2");
    const dependent = await makeTask("Dependent 2");
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, dependent.id, blocker.id);

    await taskRepository.update(LOCAL_WORKSPACE_ID, blocker.id, { status: "done" });
    assert.equal((await taskRepository.findById(LOCAL_WORKSPACE_ID, dependent.id))?.blocked, false);

    await taskRepository.update(LOCAL_WORKSPACE_ID, blocker.id, { status: "todo" });
    assert.equal((await taskRepository.findById(LOCAL_WORKSPACE_ID, dependent.id))?.blocked, true);
  });

  it("a cancelled blocker also unblocks its dependent", async () => {
    const blocker = await makeTask("Blocker 3");
    const dependent = await makeTask("Dependent 3");
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, dependent.id, blocker.id);

    await taskRepository.update(LOCAL_WORKSPACE_ID, blocker.id, { status: "cancelled" });
    assert.equal((await taskRepository.findById(LOCAL_WORKSPACE_ID, dependent.id))?.blocked, false);
  });

  it("listBlockers and listDependents report the right direction", async () => {
    const blocker = await makeTask("Blocker 4");
    const dependent = await makeTask("Dependent 4");
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, dependent.id, blocker.id);

    const blockers = await taskRepository.listBlockers(LOCAL_WORKSPACE_ID, dependent.id);
    assert.deepEqual(
      blockers.map((t) => t.id),
      [blocker.id],
    );

    const dependents = await taskRepository.listDependents(LOCAL_WORKSPACE_ID, blocker.id);
    assert.deepEqual(
      dependents.map((t) => t.id),
      [dependent.id],
    );
  });

  it("rejects a task depending on itself", async () => {
    const { DependencyCycleError } = await import("../../src/core/tasks/errors");
    const task = await makeTask("Self");
    await assert.rejects(
      () => taskRepository.addDependency(LOCAL_WORKSPACE_ID, task.id, task.id),
      (error: unknown) => {
        assert.ok(error instanceof DependencyCycleError);
        return true;
      },
    );
  });

  it("rejects a direct two-node cycle (A depends on B, B depends on A)", async () => {
    const { DependencyCycleError } = await import("../../src/core/tasks/errors");
    const a = await makeTask("A");
    const b = await makeTask("B");

    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, a.id, b.id);
    await assert.rejects(
      () => taskRepository.addDependency(LOCAL_WORKSPACE_ID, b.id, a.id),
      (error: unknown) => {
        assert.ok(error instanceof DependencyCycleError);
        return true;
      },
    );
  });

  it("rejects a transitive three-node cycle (A→B→C, then C→A)", async () => {
    const { DependencyCycleError } = await import("../../src/core/tasks/errors");
    const a = await makeTask("Transitive A");
    const b = await makeTask("Transitive B");
    const c = await makeTask("Transitive C");

    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, a.id, b.id);
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, b.id, c.id);

    await assert.rejects(
      () => taskRepository.addDependency(LOCAL_WORKSPACE_ID, c.id, a.id),
      (error: unknown) => {
        assert.ok(error instanceof DependencyCycleError);
        return true;
      },
    );
  });

  it("adding the same edge twice is a no-op, not an error", async () => {
    const a = await makeTask("Idempotent A");
    const b = await makeTask("Idempotent B");

    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, a.id, b.id);
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, a.id, b.id);

    const blockers = await taskRepository.listBlockers(LOCAL_WORKSPACE_ID, a.id);
    assert.equal(blockers.length, 1);
  });

  it("removeDependency clears the edge, and is a no-op if it never existed", async () => {
    const a = await makeTask("Remove A");
    const b = await makeTask("Remove B");
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, a.id, b.id);

    await taskRepository.removeDependency(LOCAL_WORKSPACE_ID, a.id, b.id);
    assert.equal((await taskRepository.findById(LOCAL_WORKSPACE_ID, a.id))?.blocked, false);

    // Second removal of the same (now-gone) edge must not throw.
    await taskRepository.removeDependency(LOCAL_WORKSPACE_ID, a.id, b.id);
  });
});

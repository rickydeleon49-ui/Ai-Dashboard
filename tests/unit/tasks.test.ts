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
let checklistRepository: import("../../src/db/repositories/checklist-repository").ChecklistRepository;
let projectId: string;

before(async () => {
  await migrate();
  ({ projectRepository, milestoneRepository, taskRepository, checklistRepository } = await import(
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

  it("rejects moving a blocked task to done, so transitive blocking can't be bypassed", async () => {
    const { TaskBlockedError } = await import("../../src/core/tasks/errors");
    // A depends on B, B depends on C (still open). B is itself blocked, so
    // completing it directly would make A wrongly report unblocked — see
    // loadBlockedSet's own comment on why this must be rejected.
    const a = await makeTask("Transitive A");
    const b = await makeTask("Transitive B");
    const c = await makeTask("Transitive C");
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, a.id, b.id);
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, b.id, c.id);

    assert.equal((await taskRepository.findById(LOCAL_WORKSPACE_ID, b.id))?.blocked, true);
    await assert.rejects(
      () => taskRepository.update(LOCAL_WORKSPACE_ID, b.id, { status: "done" }),
      (error: unknown) => {
        assert.ok(error instanceof TaskBlockedError);
        return true;
      },
    );

    // Nothing was written — B is still blocked, A still (correctly) unblocked-by-B's-status is moot since B never became done.
    assert.equal((await taskRepository.findById(LOCAL_WORKSPACE_ID, b.id))?.status, "todo");
  });

  it("still allows cancelling a blocked task", async () => {
    const dependent = await makeTask("Cancel Dependent");
    const blocker = await makeTask("Cancel Blocker");
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, dependent.id, blocker.id);

    const cancelled = await taskRepository.update(LOCAL_WORKSPACE_ID, dependent.id, { status: "cancelled" });
    assert.equal(cancelled?.status, "cancelled");
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

  it("marks A blocked when A depends on B and B depends on unfinished C", async () => {
    const a = await makeTask("Case 1 - A");
    const b = await makeTask("Case 1 - B");
    const c = await makeTask("Case 1 - C");
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, a.id, b.id);
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, b.id, c.id);

    const aLoaded = await taskRepository.findById(LOCAL_WORKSPACE_ID, a.id);
    assert.equal(aLoaded?.blocked, true);
  });

  it("re-blocks upstream tasks A and B when C is reopened after A, B, C were completed", async () => {
    const { TaskBlockedError } = await import("../../src/core/tasks/errors");
    const a = await makeTask("Case 2 - A");
    const b = await makeTask("Case 2 - B");
    const c = await makeTask("Case 2 - C");
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, a.id, b.id);
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, b.id, c.id);

    // Complete C, then B, then A
    await taskRepository.update(LOCAL_WORKSPACE_ID, c.id, { status: "done" });
    await taskRepository.update(LOCAL_WORKSPACE_ID, b.id, { status: "done" });
    await taskRepository.update(LOCAL_WORKSPACE_ID, a.id, { status: "done" });

    assert.equal((await taskRepository.findById(LOCAL_WORKSPACE_ID, a.id))?.blocked, false);
    assert.equal((await taskRepository.findById(LOCAL_WORKSPACE_ID, b.id))?.blocked, false);

    // Reopen C to todo
    await taskRepository.update(LOCAL_WORKSPACE_ID, c.id, { status: "todo" });

    // Under the invariant: A and B retain their historical done status, but are dynamically blocked: true
    const aAfter = await taskRepository.findById(LOCAL_WORKSPACE_ID, a.id);
    const bAfter = await taskRepository.findById(LOCAL_WORKSPACE_ID, b.id);
    assert.equal(aAfter?.status, "done");
    assert.equal(aAfter?.blocked, true);
    assert.equal(bAfter?.status, "done");
    assert.equal(bAfter?.blocked, true);

    // Attempting to re-save status done while transitively blocked is rejected
    await assert.rejects(
      () => taskRepository.update(LOCAL_WORKSPACE_ID, a.id, { status: "done" }),
      (err: unknown) => {
        assert.ok(err instanceof TaskBlockedError);
        return true;
      },
    );
  });

  it("marks an already-completed task blocked when an unfinished dependency is added to it", async () => {
    const { TaskBlockedError } = await import("../../src/core/tasks/errors");
    const a = await makeTask("Case 3 - A");
    const b = await makeTask("Case 3 - B");

    // Complete A while it has no dependencies
    await taskRepository.update(LOCAL_WORKSPACE_ID, a.id, { status: "done" });
    assert.equal((await taskRepository.findById(LOCAL_WORKSPACE_ID, a.id))?.blocked, false);

    // Now add unfinished dependency B to completed task A
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, a.id, b.id);

    const aLoaded = await taskRepository.findById(LOCAL_WORKSPACE_ID, a.id);
    assert.equal(aLoaded?.status, "done");
    assert.equal(aLoaded?.blocked, true);

    // Moving or confirming done on blocked task A must be rejected
    await assert.rejects(
      () => taskRepository.update(LOCAL_WORKSPACE_ID, a.id, { status: "done" }),
      (err: unknown) => {
        assert.ok(err instanceof TaskBlockedError);
        return true;
      },
    );
  });

  it("keeps A blocked when direct dependency B is completed while B is still transitively blocked by C", async () => {
    const a = await makeTask("Case 4 - A");
    const b = await makeTask("Case 4 - B");
    const c = await makeTask("Case 4 - C");

    // Complete B before adding C as dependency to B
    await taskRepository.update(LOCAL_WORKSPACE_ID, b.id, { status: "done" });
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, a.id, b.id);
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, b.id, c.id);

    // B is status=done but transitively blocked by C. A depends on B.
    // A must be reported as blocked!
    const aLoaded = await taskRepository.findById(LOCAL_WORKSPACE_ID, a.id);
    assert.equal(aLoaded?.blocked, true);
  });

  it("marks task blocked when multiple branches exist and only one branch is blocked", async () => {
    const a = await makeTask("Case 5 - Root");
    const b = await makeTask("Case 5 - Branch 1");
    const c = await makeTask("Case 5 - Unfinished Leaf");
    const d = await makeTask("Case 5 - Branch 2 Done");

    await taskRepository.update(LOCAL_WORKSPACE_ID, d.id, { status: "done" });
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, a.id, b.id);
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, a.id, d.id);
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, b.id, c.id);

    const aLoaded = await taskRepository.findById(LOCAL_WORKSPACE_ID, a.id);
    assert.equal(aLoaded?.blocked, true);

    // Complete leaf C -> now both branches are satisfied
    await taskRepository.update(LOCAL_WORKSPACE_ID, c.id, { status: "done" });
    await taskRepository.update(LOCAL_WORKSPACE_ID, b.id, { status: "done" });

    const aAfter = await taskRepository.findById(LOCAL_WORKSPACE_ID, a.id);
    assert.equal(aAfter?.blocked, false);
  });
});

describe("subtask hierarchy rules (SQLite)", () => {
  async function makeTask(title: string, parentTaskId?: string | null) {
    return taskRepository.create(LOCAL_WORKSPACE_ID, { projectId, title, parentTaskId });
  }

  it("rejects self-parenting on update", async () => {
    const { InvalidParentTaskError } = await import("../../src/core/tasks/errors");
    const task = await makeTask("Self Parent");
    await assert.rejects(
      () => taskRepository.update(LOCAL_WORKSPACE_ID, task.id, { parentTaskId: task.id }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidParentTaskError);
        assert.match((err as Error).message, /cannot be its own parent/);
        return true;
      },
    );
  });

  it("rejects creating a child beneath another child (max 1 level)", async () => {
    const { InvalidParentTaskError } = await import("../../src/core/tasks/errors");
    const top = await makeTask("Top Level");
    const child = await makeTask("Child Task", top.id);

    await assert.rejects(
      () => makeTask("Grandchild Task", child.id),
      (err: unknown) => {
        assert.ok(err instanceof InvalidParentTaskError);
        assert.match((err as Error).message, /must be a top-level task/);
        return true;
      },
    );
  });

  it("rejects moving a task beneath another child", async () => {
    const { InvalidParentTaskError } = await import("../../src/core/tasks/errors");
    const top = await makeTask("Top Level 2");
    const child = await makeTask("Child 2", top.id);
    const other = await makeTask("Other Task");

    await assert.rejects(
      () => taskRepository.update(LOCAL_WORKSPACE_ID, other.id, { parentTaskId: child.id }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidParentTaskError);
        assert.match((err as Error).message, /must be a top-level task/);
        return true;
      },
    );
  });

  it("rejects making a task with existing children into a child", async () => {
    const { InvalidParentTaskError } = await import("../../src/core/tasks/errors");
    const parentA = await makeTask("Parent A");
    await makeTask("Child of A", parentA.id);

    const parentB = await makeTask("Parent B");

    // Making parentA a child of parentB would create a 2-level hierarchy
    await assert.rejects(
      () => taskRepository.update(LOCAL_WORKSPACE_ID, parentA.id, { parentTaskId: parentB.id }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidParentTaskError);
        assert.match((err as Error).message, /with subtasks cannot become a subtask/);
        return true;
      },
    );
  });

  it("rejects cross-project parent tasks", async () => {
    const { InvalidParentTaskError } = await import("../../src/core/tasks/errors");
    const otherProject = await projectRepository.create(LOCAL_WORKSPACE_ID, {
      name: "Other Project",
      description: "Another project",
    });

    const parentInOther = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId: otherProject.id,
      title: "Parent in Other",
    });

    await assert.rejects(
      () => makeTask("Task in Project 1", parentInOther.id),
      (err: unknown) => {
        assert.ok(err instanceof InvalidParentTaskError);
        assert.match((err as Error).message, /must belong to the same project/);
        return true;
      },
    );
  });
});

describe("DrizzleTaskRepository: grouped aggregate checklist counts (SQLite)", () => {
    it("returns correct checklistDone and checklistTotal across list, findById, and mutations", async () => {
      const t1 = await taskRepository.create(LOCAL_WORKSPACE_ID, {
        projectId,
        title: "Task with checklist (SQLite)",
      });
      const t2 = await taskRepository.create(LOCAL_WORKSPACE_ID, {
        projectId,
        title: "Task without checklist (SQLite)",
      });

      // Initial state: 0/0
      const initialList = await taskRepository.list(LOCAL_WORKSPACE_ID, projectId);
      const initialT1 = initialList.find((t) => t.id === t1.id);
      const initialT2 = initialList.find((t) => t.id === t2.id);
      assert.equal(initialT1?.checklistTotal, 0);
      assert.equal(initialT1?.checklistDone, 0);
      assert.equal(initialT2?.checklistTotal, 0);
      assert.equal(initialT2?.checklistDone, 0);

      // Add 3 checklist items to t1 (item1: done, item2: not done, item3: done)
      const item1 = await checklistRepository.create(LOCAL_WORKSPACE_ID, t1.id, { text: "Item 1" });
      const item2 = await checklistRepository.create(LOCAL_WORKSPACE_ID, t1.id, { text: "Item 2" });
      const item3 = await checklistRepository.create(LOCAL_WORKSPACE_ID, t1.id, { text: "Item 3" });

      await checklistRepository.complete(LOCAL_WORKSPACE_ID, t1.id, item1.id);
      await checklistRepository.complete(LOCAL_WORKSPACE_ID, t1.id, item3.id);

      // Verify list(LOCAL_WORKSPACE_ID, projectId)
      const listAfter = await taskRepository.list(LOCAL_WORKSPACE_ID, projectId);
      const readT1 = listAfter.find((t) => t.id === t1.id);
      const readT2 = listAfter.find((t) => t.id === t2.id);
      assert.equal(readT1?.checklistTotal, 3);
      assert.equal(readT1?.checklistDone, 2);
      assert.equal(readT2?.checklistTotal, 0);
      assert.equal(readT2?.checklistDone, 0);

      // Verify listForWorkspace returns identical counts
      const wsList = await taskRepository.listForWorkspace(LOCAL_WORKSPACE_ID);
      const wsT1 = wsList.find((t) => t.id === t1.id);
      assert.equal(wsT1?.checklistTotal, 3);
      assert.equal(wsT1?.checklistDone, 2);

      // Verify findById returns identical counts
      const directT1 = await taskRepository.findById(LOCAL_WORKSPACE_ID, t1.id);
      assert.equal(directT1?.checklistTotal, 3);
      assert.equal(directT1?.checklistDone, 2);

      // Complete item 2 -> counts become 3/3
      await checklistRepository.complete(LOCAL_WORKSPACE_ID, t1.id, item2.id);
      const directT1AllDone = await taskRepository.findById(LOCAL_WORKSPACE_ID, t1.id);
      assert.equal(directT1AllDone?.checklistTotal, 3);
      assert.equal(directT1AllDone?.checklistDone, 3);

      // Reopen item 1 -> counts become 2/3
      await checklistRepository.reopen(LOCAL_WORKSPACE_ID, t1.id, item1.id);
      const directT1Reopened = await taskRepository.findById(LOCAL_WORKSPACE_ID, t1.id);
      assert.equal(directT1Reopened?.checklistTotal, 3);
      assert.equal(directT1Reopened?.checklistDone, 2);

      // Delete item 2 -> counts become 1/2
      await checklistRepository.delete(LOCAL_WORKSPACE_ID, t1.id, item2.id);
      const directT1Deleted = await taskRepository.findById(LOCAL_WORKSPACE_ID, t1.id);
      assert.equal(directT1Deleted?.checklistTotal, 2);
      assert.equal(directT1Deleted?.checklistDone, 1);

      // Convert item 3 to task -> t1 counts become 0/1, and converted task has 0/0
      const converted = await checklistRepository.convertToTask(LOCAL_WORKSPACE_ID, t1.id, item3.id);
      assert.equal(converted.checklistTotal, 0);
      assert.equal(converted.checklistDone, 0);

      const directT1AfterConvert = await taskRepository.findById(LOCAL_WORKSPACE_ID, t1.id);
      assert.equal(directT1AfterConvert?.checklistTotal, 1);
      assert.equal(directT1AfterConvert?.checklistDone, 0);
    });
  });

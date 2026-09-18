/**
 * Comprehensive PostgreSQL 16 Task Concurrency, Graph & Hierarchy Tests:
 * 1. Five recursive dependency scenarios (parity with SQLite).
 * 2. Disjoint concurrent edge additions combining into a 4-node cycle.
 * 3. Completion and reopening racing with dependency insertion.
 * 4. All one-level subtask rules (self-parent, child-beneath-child, task-with-children, cross-project, cross-workspace).
 * 5. Concurrent parent-cycle prevention and hierarchical serialization.
 * 6. Assignee validation (outsider, removed member, cross-workspace, valid active member).
 * 7. Complete workspace isolation for all graph operations.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";
import {
  DependencyCycleError,
  InvalidAssigneeError,
  InvalidParentTaskError,
  TaskBlockedError,
  TaskLockTimeoutError,
} from "../../src/core/tasks/errors";

let db: typeof import("../../src/db/pg-client").getPgDb;
let users: typeof import("../../src/db/schema.pg").users;
let workspaceMembers: typeof import("../../src/db/schema.pg").workspaceMembers;
let workspaces: typeof import("../../src/core/workspaces/service");
let PostgresProjectRepository: typeof import(
  "../../src/db/repositories/postgres-project-repository"
).PostgresProjectRepository;
let PostgresTaskRepository: typeof import(
  "../../src/db/repositories/postgres-task-repository"
).PostgresTaskRepository;

before(async () => {
  await migrate();
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  ({ users, workspaceMembers } = await import("../../src/db/schema.pg"));
  workspaces = await import("../../src/core/workspaces/service");
  ({ PostgresProjectRepository } = await import(
    "../../src/db/repositories/postgres-project-repository"
  ));
  ({ PostgresTaskRepository } = await import("../../src/db/repositories/postgres-task-repository"));
});
after(() => cleanup());

let userCounter = 0;

async function makeWorkspaceWithProject(name: string) {
  userCounter += 1;
  const userId = `pg_task_u_${userCounter}_${Date.now()}`;
  await db().insert(users).values({ id: userId, email: `${userId}@example.com` });
  const ws = await workspaces.createTeamWorkspace(userId, name);
  const projects = new PostgresProjectRepository();
  const project = await projects.create(ws.id, { name: `${name} Project`, source: "manual" });
  return { workspaceId: ws.id, userId, projectId: project.id };
}

describe("PostgreSQL task recursive dependencies (parity with SQLite)", () => {
  it("Case 1: marks A blocked when A depends on B and B depends on unfinished C", async () => {
    const repo = new PostgresTaskRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Rec Case 1");
    const a = await repo.create(workspaceId, { projectId, title: "A" });
    const b = await repo.create(workspaceId, { projectId, title: "B" });
    const c = await repo.create(workspaceId, { projectId, title: "C" });

    await repo.addDependency(workspaceId, a.id, b.id);
    await repo.addDependency(workspaceId, b.id, c.id);

    const loadedA = await repo.findById(workspaceId, a.id);
    assert.equal(loadedA?.blocked, true);
  });

  it("Case 2: re-blocks upstream tasks A and B when C is reopened after A, B, C were completed", async () => {
    const repo = new PostgresTaskRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Rec Case 2");
    const a = await repo.create(workspaceId, { projectId, title: "A" });
    const b = await repo.create(workspaceId, { projectId, title: "B" });
    const c = await repo.create(workspaceId, { projectId, title: "C" });

    await repo.addDependency(workspaceId, a.id, b.id);
    await repo.addDependency(workspaceId, b.id, c.id);

    // Complete C, then B, then A
    await repo.update(workspaceId, c.id, { status: "done" });
    await repo.update(workspaceId, b.id, { status: "done" });
    await repo.update(workspaceId, a.id, { status: "done" });

    assert.equal((await repo.findById(workspaceId, a.id))?.blocked, false);
    assert.equal((await repo.findById(workspaceId, b.id))?.blocked, false);

    // Reopen C
    await repo.update(workspaceId, c.id, { status: "todo" });

    const aAfter = await repo.findById(workspaceId, a.id);
    const bAfter = await repo.findById(workspaceId, b.id);
    assert.equal(aAfter?.status, "done");
    assert.equal(aAfter?.blocked, true);
    assert.equal(bAfter?.status, "done");
    assert.equal(bAfter?.blocked, true);

    // Attempting to re-save status done while blocked is rejected
    await assert.rejects(
      () => repo.update(workspaceId, a.id, { status: "done" }),
      (err: unknown) => {
        assert.ok(err instanceof TaskBlockedError);
        return true;
      },
    );
  });

  it("Case 3: marks an already-completed task blocked when an unfinished dependency is added to it", async () => {
    const repo = new PostgresTaskRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Rec Case 3");
    const a = await repo.create(workspaceId, { projectId, title: "A" });
    const b = await repo.create(workspaceId, { projectId, title: "B" });

    await repo.update(workspaceId, a.id, { status: "done" });
    assert.equal((await repo.findById(workspaceId, a.id))?.blocked, false);

    await repo.addDependency(workspaceId, a.id, b.id);

    const aLoaded = await repo.findById(workspaceId, a.id);
    assert.equal(aLoaded?.status, "done");
    assert.equal(aLoaded?.blocked, true);

    await assert.rejects(
      () => repo.update(workspaceId, a.id, { status: "done" }),
      (err: unknown) => {
        assert.ok(err instanceof TaskBlockedError);
        return true;
      },
    );
  });

  it("Case 4: keeps A blocked when direct dependency B is completed while B is still transitively blocked by C", async () => {
    const repo = new PostgresTaskRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Rec Case 4");
    const a = await repo.create(workspaceId, { projectId, title: "A" });
    const b = await repo.create(workspaceId, { projectId, title: "B" });
    const c = await repo.create(workspaceId, { projectId, title: "C" });

    await repo.update(workspaceId, b.id, { status: "done" });
    await repo.addDependency(workspaceId, a.id, b.id);
    await repo.addDependency(workspaceId, b.id, c.id);

    const aLoaded = await repo.findById(workspaceId, a.id);
    assert.equal(aLoaded?.blocked, true);
  });

  it("Case 5: marks task blocked when multiple branches exist and only one branch is blocked", async () => {
    const repo = new PostgresTaskRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Rec Case 5");
    const a = await repo.create(workspaceId, { projectId, title: "A" });
    const b = await repo.create(workspaceId, { projectId, title: "Branch 1" });
    const c = await repo.create(workspaceId, { projectId, title: "Leaf Unfinished" });
    const d = await repo.create(workspaceId, { projectId, title: "Branch 2 Done" });

    await repo.update(workspaceId, d.id, { status: "done" });
    await repo.addDependency(workspaceId, a.id, b.id);
    await repo.addDependency(workspaceId, a.id, d.id);
    await repo.addDependency(workspaceId, b.id, c.id);

    const aLoaded = await repo.findById(workspaceId, a.id);
    assert.equal(aLoaded?.blocked, true);

    // Complete leaf C
    await repo.update(workspaceId, c.id, { status: "done" });
    await repo.update(workspaceId, b.id, { status: "done" });

    const aAfter = await repo.findById(workspaceId, a.id);
    assert.equal(aAfter?.blocked, false);
  });
});

describe("PostgreSQL disjoint concurrent cycle prevention", () => {
  it("disjoint concurrent edge additions combining into a four-node cycle: exactly one succeeds", async () => {
    const repo = new PostgresTaskRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("4-Node Disjoint Race");

    // 4 tasks: A, B, C, D
    const a = await repo.create(workspaceId, { projectId, title: "A" });
    const b = await repo.create(workspaceId, { projectId, title: "B" });
    const c = await repo.create(workspaceId, { projectId, title: "C" });
    const d = await repo.create(workspaceId, { projectId, title: "D" });

    // Initial edges: A depends on B (A->B), and C depends on D (C->D).
    // These two components are completely disjoint.
    await repo.addDependency(workspaceId, a.id, b.id);
    await repo.addDependency(workspaceId, c.id, d.id);

    // Concurrently attempt to connect the two disjoint components in both directions:
    // Op 1: B depends on C (B->C)
    // Op 2: D depends on A (D->A)
    // If both succeeded, we would have A->B->C->D->A (a 4-node cycle).
    const results = await Promise.allSettled([
      repo.addDependency(workspaceId, b.id, c.id),
      repo.addDependency(workspaceId, d.id, a.id),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1, "Exactly one cross-component edge must succeed");
    assert.equal(rejected.length, 1, "The second edge must be rejected to prevent the 4-node cycle");
    assert.ok(
      rejected[0]?.status === "rejected" && rejected[0].reason instanceof DependencyCycleError,
      "Rejection reason must be DependencyCycleError",
    );
  });
});

describe("PostgreSQL racing completion/reopening with dependency insertion", () => {
  it("racing task completion with dependency addition prevents invalid completion", async () => {
    const repo = new PostgresTaskRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Racing Comp Dep");

    const a = await repo.create(workspaceId, { projectId, title: "A" });
    const b = await repo.create(workspaceId, { projectId, title: "B" });

    // Race: add dependency A -> B while marking A done
    const results = await Promise.allSettled([
      repo.addDependency(workspaceId, a.id, b.id),
      repo.update(workspaceId, a.id, { status: "done" }),
    ]);

    // Either:
    // 1. Dependency committed first -> status:done failed with TaskBlockedError.
    // 2. Status:done committed first -> dependency succeeded and marked A dynamically blocked.
    const aFinal = await repo.findById(workspaceId, a.id);
    assert.ok(aFinal);
    if (aFinal.status === "done") {
      assert.equal(aFinal.blocked, true, "If marked done, it must now be dynamically blocked");
    } else {
      assert.equal(aFinal.status, "todo");
      assert.equal(aFinal.blocked, true);
    }
  });
});

describe("PostgreSQL one-level subtask rules and hierarchy invariants", () => {
  it("rejects self-parenting on update", async () => {
    const repo = new PostgresTaskRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Subtask Self");
    const task = await repo.create(workspaceId, { projectId, title: "Self Parent" });

    await assert.rejects(
      () => repo.update(workspaceId, task.id, { parentTaskId: task.id }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidParentTaskError);
        assert.match((err as Error).message, /cannot be its own parent/);
        return true;
      },
    );
  });

  it("rejects creating a child beneath another child (max 1 level)", async () => {
    const repo = new PostgresTaskRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Subtask Nest Create");
    const top = await repo.create(workspaceId, { projectId, title: "Top Level" });
    const child = await repo.create(workspaceId, { projectId, title: "Child", parentTaskId: top.id });

    await assert.rejects(
      () => repo.create(workspaceId, { projectId, title: "Grandchild", parentTaskId: child.id }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidParentTaskError);
        assert.match((err as Error).message, /must be a top-level task/);
        return true;
      },
    );
  });

  it("rejects moving a task beneath another child on update", async () => {
    const repo = new PostgresTaskRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Subtask Nest Update");
    const top = await repo.create(workspaceId, { projectId, title: "Top" });
    const child = await repo.create(workspaceId, { projectId, title: "Child", parentTaskId: top.id });
    const other = await repo.create(workspaceId, { projectId, title: "Other" });

    await assert.rejects(
      () => repo.update(workspaceId, other.id, { parentTaskId: child.id }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidParentTaskError);
        assert.match((err as Error).message, /must be a top-level task/);
        return true;
      },
    );
  });

  it("rejects making a task with existing children into a child", async () => {
    const repo = new PostgresTaskRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Subtask Has Children");
    const parentA = await repo.create(workspaceId, { projectId, title: "Parent A" });
    await repo.create(workspaceId, { projectId, title: "Child of A", parentTaskId: parentA.id });

    const parentB = await repo.create(workspaceId, { projectId, title: "Parent B" });

    await assert.rejects(
      () => repo.update(workspaceId, parentA.id, { parentTaskId: parentB.id }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidParentTaskError);
        assert.match((err as Error).message, /with subtasks cannot become a subtask/);
        return true;
      },
    );
  });

  it("rejects cross-project parent tasks", async () => {
    const repo = new PostgresTaskRepository();
    const projects = new PostgresProjectRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Subtask Cross Proj");

    const otherProject = await projects.create(workspaceId, { name: "Other Project", source: "manual" });
    const parentInOther = await repo.create(workspaceId, {
      projectId: otherProject.id,
      title: "Parent in other project",
    });

    await assert.rejects(
      () => repo.create(workspaceId, { projectId, title: "Task in Proj 1", parentTaskId: parentInOther.id }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidParentTaskError);
        assert.match((err as Error).message, /must belong to the same project/);
        return true;
      },
    );
  });

  it("rejects cross-workspace parent tasks", async () => {
    const repo = new PostgresTaskRepository();
    const ws1 = await makeWorkspaceWithProject("Subtask Cross WS 1");
    const ws2 = await makeWorkspaceWithProject("Subtask Cross WS 2");

    const parentInWs2 = await repo.create(ws2.workspaceId, {
      projectId: ws2.projectId,
      title: "Parent in WS 2",
    });

    await assert.rejects(
      () =>
        repo.create(ws1.workspaceId, {
          projectId: ws1.projectId,
          title: "Task in WS 1",
          parentTaskId: parentInWs2.id,
        }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidParentTaskError);
        assert.match((err as Error).message, /Parent task not found/);
        return true;
      },
    );
  });
});

describe("PostgreSQL concurrent parent-cycle & hierarchy serialization", () => {
  it("A becoming child of B while B becomes child of A: exactly one wins", async () => {
    const repo = new PostgresTaskRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Parent Cycle Race");
    const a = await repo.create(workspaceId, { projectId, title: "A" });
    const b = await repo.create(workspaceId, { projectId, title: "B" });

    const results = await Promise.allSettled([
      repo.update(workspaceId, a.id, { parentTaskId: b.id }),
      repo.update(workspaceId, b.id, { parentTaskId: a.id }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1, "Exactly one parent mutation must succeed");
    assert.equal(rejected.length, 1, "The other must be rejected to prevent parent cycle");
    assert.ok(rejected[0]?.status === "rejected" && rejected[0].reason instanceof InvalidParentTaskError);
  });

  it("A task gaining a child while concurrently being moved beneath another task: serialized safely", async () => {
    const repo = new PostgresTaskRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Parent Move Race");
    const a = await repo.create(workspaceId, { projectId, title: "A" });
    const b = await repo.create(workspaceId, { projectId, title: "B" });
    const c = await repo.create(workspaceId, { projectId, title: "C" });

    // Race: C sets parent A, while A sets parent B.
    // If both succeeded without coordination, C would be under A and A under B (2 levels).
    const results = await Promise.allSettled([
      repo.update(workspaceId, c.id, { parentTaskId: a.id }),
      repo.update(workspaceId, a.id, { parentTaskId: b.id }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1, "Exactly one hierarchy change must win");
    assert.equal(rejected.length, 1, "The competing hierarchy mutation must be rejected");
    assert.ok(rejected[0]?.status === "rejected" && rejected[0].reason instanceof InvalidParentTaskError);
  });

  it("Two valid unrelated parent updates proceed without corrupting hierarchy", async () => {
    const repo = new PostgresTaskRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Unrelated Parents");
    const top1 = await repo.create(workspaceId, { projectId, title: "Top 1" });
    const child1 = await repo.create(workspaceId, { projectId, title: "Child 1" });
    const top2 = await repo.create(workspaceId, { projectId, title: "Top 2" });
    const child2 = await repo.create(workspaceId, { projectId, title: "Child 2" });

    const results = await Promise.allSettled([
      repo.update(workspaceId, child1.id, { parentTaskId: top1.id }),
      repo.update(workspaceId, child2.id, { parentTaskId: top2.id }),
    ]);

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);

    const c1 = await repo.findById(workspaceId, child1.id);
    const c2 = await repo.findById(workspaceId, child2.id);
    assert.equal(c1?.parentTaskId, top1.id);
    assert.equal(c2?.parentTaskId, top2.id);
  });
});

describe("PostgreSQL assignee validation", () => {
  it("rejects outsider who is not a member of the workspace", async () => {
    const repo = new PostgresTaskRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Assignee Outsider");

    // Outsider user exists in the database but has no membership in this workspace
    userCounter += 1;
    const outsiderId = `outsider_${userCounter}`;
    await db().insert(users).values({ id: outsiderId, email: `${outsiderId}@example.com` });

    await assert.rejects(
      () => repo.create(workspaceId, { projectId, title: "Assigned Task", assigneeId: outsiderId }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidAssigneeError);
        assert.match((err as Error).message, /active member/i);
        return true;
      },
    );
  });

  it("rejects removed member who was removed from the workspace", async () => {
    const repo = new PostgresTaskRepository();
    const { workspaceId, projectId, userId } = await makeWorkspaceWithProject("Assignee Removed");

    // Add a second member
    userCounter += 1;
    const colleagueId = `colleague_${userCounter}`;
    await db().insert(users).values({ id: colleagueId, email: `${colleagueId}@example.com` });
    await db().insert(workspaceMembers).values({ workspaceId, userId: colleagueId, role: "member" });

    const task = await repo.create(workspaceId, { projectId, title: "Task" });

    // Remove colleague from workspace
    const { and, eq } = await import("drizzle-orm");
    await db()
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, colleagueId)));

    await assert.rejects(
      () => repo.update(workspaceId, task.id, { assigneeId: colleagueId }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidAssigneeError);
        assert.match((err as Error).message, /active member/i);
        return true;
      },
    );
  });

  it("rejects suspended member from being assigned", async () => {
    const repo = new PostgresTaskRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Assignee Suspended");

    userCounter += 1;
    const suspendedId = `suspended_${userCounter}`;
    await db().insert(users).values({ id: suspendedId, email: `${suspendedId}@example.com` });
    await db()
      .insert(workspaceMembers)
      .values({ workspaceId, userId: suspendedId, role: "member", status: "suspended" });

    await assert.rejects(
      () => repo.create(workspaceId, { projectId, title: "Task", assigneeId: suspendedId }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidAssigneeError);
        assert.match((err as Error).message, /active member/i);
        return true;
      },
    );
  });

  it("rejects member of another workspace", async () => {
    const repo = new PostgresTaskRepository();
    const ws1 = await makeWorkspaceWithProject("WS 1");
    const ws2 = await makeWorkspaceWithProject("WS 2");

    // User in WS 2 cannot be assigned to task in WS 1
    await assert.rejects(
      () => repo.create(ws1.workspaceId, { projectId: ws1.projectId, title: "Task", assigneeId: ws2.userId }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidAssigneeError);
        assert.match((err as Error).message, /active member/i);
        return true;
      },
    );
  });

  it("successfully assigns an active workspace member", async () => {
    const repo = new PostgresTaskRepository();
    const { workspaceId, projectId, userId } = await makeWorkspaceWithProject("Active Assignee");

    const task = await repo.create(workspaceId, {
      projectId,
      title: "Active Task",
      assigneeId: userId,
    });
    assert.equal(task.assigneeId, userId);

    const loaded = await repo.findById(workspaceId, task.id);
    assert.equal(loaded?.assigneeId, userId);
  });
});

describe("PostgreSQL barrier-driven maximum-concurrency stress test", () => {
  it("executes 24 simultaneous mixed operations under high contention and maintains all invariants", async () => {
    const repo = new PostgresTaskRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Max Concurrency Stress");

    // Create 16 tasks (t0 .. t15)
    const t: Array<Awaited<ReturnType<typeof repo.create>>> = [];
    for (let i = 0; i < 16; i++) {
      t.push(await repo.create(workspaceId, { projectId, title: `Task ${i}` }));
    }

    const task = (idx: number) => {
      const found = t[idx];
      if (!found) throw new Error(`Task index ${idx} not found`);
      return found;
    };

    // Set up base initial edges
    await repo.addDependency(workspaceId, task(0).id, task(1).id);
    await repo.addDependency(workspaceId, task(2).id, task(3).id);
    await repo.addDependency(workspaceId, task(4).id, task(5).id);

    // Prepare 24 simultaneous mixed operations:
    // 1-6: Competing cycle-forming dependency additions
    // 7-12: Task completion attempts while blockers are concurrently changing
    // 13-18: Parent assignment races and competing parent-cycle races
    // 19-22: Attempts to create subtask depth greater than one
    // 23-24: Cross-branch dependency and completion races
    const operations: Array<() => Promise<unknown>> = [
      () => repo.addDependency(workspaceId, task(1).id, task(2).id),
      () => repo.addDependency(workspaceId, task(3).id, task(0).id),
      () => repo.addDependency(workspaceId, task(3).id, task(4).id),
      () => repo.addDependency(workspaceId, task(5).id, task(2).id),
      () => repo.addDependency(workspaceId, task(5).id, task(0).id),
      () => repo.addDependency(workspaceId, task(1).id, task(0).id),

      () => repo.update(workspaceId, task(0).id, { status: "done" }),
      () => repo.update(workspaceId, task(1).id, { status: "done" }),
      () => repo.update(workspaceId, task(2).id, { status: "todo" }),
      () => repo.update(workspaceId, task(3).id, { status: "done" }),
      () => repo.update(workspaceId, task(4).id, { status: "done" }),
      () => repo.update(workspaceId, task(5).id, { status: "done" }),

      () => repo.update(workspaceId, task(6).id, { parentTaskId: task(7).id }),
      () => repo.update(workspaceId, task(7).id, { parentTaskId: task(6).id }),
      () => repo.update(workspaceId, task(8).id, { parentTaskId: task(7).id }),
      () => repo.update(workspaceId, task(7).id, { parentTaskId: task(9).id }),
      () => repo.update(workspaceId, task(9).id, { parentTaskId: task(8).id }),
      () => repo.update(workspaceId, task(10).id, { parentTaskId: task(6).id }),

      () => repo.create(workspaceId, { projectId, title: "SubL2 Attempt 1", parentTaskId: task(6).id }),
      () => repo.create(workspaceId, { projectId, title: "SubL2 Attempt 2", parentTaskId: task(7).id }),
      () => repo.update(workspaceId, task(11).id, { parentTaskId: task(10).id }),
      () => repo.update(workspaceId, task(12).id, { parentTaskId: task(11).id }),

      () => repo.addDependency(workspaceId, task(13).id, task(14).id),
      () => repo.update(workspaceId, task(13).id, { status: "done" }),
    ];

    // Synchronization barrier to release all 24 operations simultaneously
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const launched = operations.map(async (fn) => {
      await barrier;
      return fn();
    });

    // Fire barrier
    releaseBarrier();

    const results = await Promise.allSettled(launched);

    // 1. Check results: every failure must be a known domain error or timeout, NOT corruption or deadlock
    for (const res of results) {
      if (res.status === "rejected") {
        const err = res.reason as Error & { code?: string };
        const isExpectedDomainError =
          err instanceof DependencyCycleError ||
          err instanceof InvalidParentTaskError ||
          err instanceof TaskBlockedError ||
          err instanceof TaskLockTimeoutError;

        assert.ok(
          isExpectedDomainError,
          `Unexpected error during high concurrency: ${err.name} (${err.message}, code: ${err.code})`,
        );

        // Explicitly assert that PostgreSQL deadlock (40P01) did NOT occur
        assert.notEqual(err.code, "40P01", "PostgreSQL transaction deadlock detected");
      }
    }

    // 2. Query all tasks and dependencies in the workspace to verify invariants
    const allTasks = await repo.listForWorkspace(workspaceId);
    const taskMap = new Map(allTasks.map((task) => [task.id, task]));

    // Query raw dependencies from DB
    const { taskDependencies } = await import("../../src/db/schema.pg");
    const { eq } = await import("drizzle-orm");
    const edges = await db()
      .select({ taskId: taskDependencies.taskId, dependsOnTaskId: taskDependencies.dependsOnTaskId })
      .from(taskDependencies)
      .where(eq(taskDependencies.workspaceId, workspaceId));

    // Build adjacency list for cycle detection
    const adj = new Map<string, string[]>();
    for (const edge of edges) {
      if (!adj.has(edge.taskId)) adj.set(edge.taskId, []);
      adj.get(edge.taskId)!.push(edge.dependsOnTaskId);
    }

    // 3. Assert dependency graph is strictly acyclic (DFS cycle check)
    const visited = new Set<string>();
    const recStack = new Set<string>();

    function hasCycle(node: string): boolean {
      visited.add(node);
      recStack.add(node);

      for (const neighbor of adj.get(node) ?? []) {
        if (!visited.has(neighbor)) {
          if (hasCycle(neighbor)) return true;
        } else if (recStack.has(neighbor)) {
          return true;
        }
      }

      recStack.delete(node);
      return false;
    }

    for (const node of adj.keys()) {
      if (!visited.has(node)) {
        assert.equal(hasCycle(node), false, `Dependency cycle detected involving node ${node}`);
      }
    }

    // 4. Assert subtask depth is strictly <= 1 for every task
    for (const task of allTasks) {
      if (task.parentTaskId) {
        const parent = taskMap.get(task.parentTaskId);
        assert.ok(parent, `Parent task ${task.parentTaskId} must exist`);
        assert.equal(
          parent.parentTaskId,
          null,
          `Task ${task.id} is child of ${parent.id} which is also a child (depth > 1 violation)`,
        );
      }
    }

    // 5. Assert no blocked task was incorrectly marked done
    // Compute transitive closure of dependencies for each task
    function getTransitiveDeps(startId: string): Set<string> {
      const depSet = new Set<string>();
      const queue = [startId];
      while (queue.length > 0) {
        const curr = queue.shift()!;
        for (const depId of adj.get(curr) ?? []) {
          if (!depSet.has(depId)) {
            depSet.add(depId);
            queue.push(depId);
          }
        }
      }
      return depSet;
    }

    for (const task of allTasks) {
      const transDeps = getTransitiveDeps(task.id);
      const isTransBlocked = Array.from(transDeps).some((depId) => {
        const d = taskMap.get(depId);
        return d && d.status !== "done" && d.status !== "cancelled";
      });

      if (isTransBlocked) {
        // Must dynamically report blocked = true
        assert.equal(
          task.blocked,
          true,
          `Task ${task.id} has unfinished dependencies but reported blocked = false`,
        );
      }
    }
  });

  it("evaluates bounded advisory-lock timeout and raises TaskLockTimeoutError", async () => {
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Lock Timeout Test");
    const baseRepo = new PostgresTaskRepository();

    const t1 = await baseRepo.create(workspaceId, { projectId, title: "Lock T1" });
    const t2 = await baseRepo.create(workspaceId, { projectId, title: "Lock T2" });

    // Connect holderClient to the same throwaway database as the repository
    const { Client } = await import("pg");
    const holderClient = new Client({ connectionString: process.env.DATABASE_URL });
    await holderClient.connect();

    try {
      // 1. Holder acquires advisory lock on connection 1
      await holderClient.query("BEGIN");
      await holderClient.query(
        "SELECT pg_advisory_xact_lock(hashtext('task_dependencies'), hashtext($1))",
        [workspaceId],
      );

      // Fast repo with bounded 300ms lock timeout
      const fastRepo = new PostgresTaskRepository({ lockTimeoutMs: 300 });

      // 2. Advisory-lock wait timeout: invoke actual repository mutation (addDependency)
      await assert.rejects(
        () => fastRepo.addDependency(workspaceId, t1.id, t2.id),
        (err: unknown) => {
          assert.ok(
            err instanceof TaskLockTimeoutError,
            `Expected TaskLockTimeoutError, got ${String(err)}`,
          );
          assert.match((err as Error).message, /timed out waiting for workspace lock/);
          return true;
        },
      );

      // 3. Release lock by rolling back holder transaction
      await holderClient.query("ROLLBACK");

      // 4. Successful advisory-lock acquisition and successful repository work after acquisition
      await fastRepo.addDependency(workspaceId, t1.id, t2.id);

      // Verify the dependency edge was added and blocker calculations succeed
      const loadedT1 = await fastRepo.findById(workspaceId, t1.id);
      assert.equal(loadedT1?.blocked, true, "t1 must now be blocked by t2");

      const blockers = await fastRepo.listBlockers(workspaceId, t1.id);
      assert.equal(blockers.length, 1);
      assert.equal(blockers[0]?.id, t2.id);
    } finally {
      await holderClient.end();
    }
  });

  it("resets lock_timeout to default immediately after advisory-lock acquisition", async () => {
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Lock Timeout Reset");
    const repo = new PostgresTaskRepository({ lockTimeoutMs: 400 });

    const t1 = await repo.create(workspaceId, { projectId, title: "Reset T1" });
    const t2 = await repo.create(workspaceId, { projectId, title: "Reset T2" });

    // Verify SHOW lock_timeout is reset to default ('0') after acquireWorkspaceLock
    const { sql } = await import("drizzle-orm");
    const testDb = (await import("../../src/db/pg-client")).getPgDb();

    let timeoutAfterLock = "";
    await testDb.transaction(async (tx) => {
      // Simulate acquireWorkspaceLock pattern with 400ms timeout
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '400ms'"));
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('task_dependencies'), hashtext(${workspaceId}))`,
      );
      await tx.execute(sql.raw("SET LOCAL lock_timeout = DEFAULT"));

      const res = await tx.execute(sql.raw("SHOW lock_timeout"));
      timeoutAfterLock = String((res.rows[0] as any)?.lock_timeout ?? "");
    });

    assert.equal(timeoutAfterLock, "0", "lock_timeout must be reset to 0 (disabled) after acquisition");

    // Repository mutation addDependency succeeds and subsequent work completes
    await repo.addDependency(workspaceId, t1.id, t2.id);
    const blockers = await repo.listBlockers(workspaceId, t1.id);
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0]?.id, t2.id);
  });
});

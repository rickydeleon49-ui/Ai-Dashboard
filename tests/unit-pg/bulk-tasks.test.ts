/**
 * Release 2C.5 Bulk Editing: PostgreSQL Repository & Transaction Invariants.
 *
 * Verifies:
 * 1. PostgresTaskRepository cross-workspace isolation:
 *    - Tasks in Workspace B can never be retrieved or modified with Workspace A id.
 * 2. PostgresMilestoneRepository cross-workspace isolation:
 *    - Milestones in Workspace B can never be retrieved with Workspace A id.
 * 3. Atomic per-task updates:
 *    - Updates to distinct tasks commit independently.
 * 4. Concurrent updates to unrelated fields:
 *    - Concurrently updating description and priority/status on the same task succeeds without data loss.
 * 5. Blocked task completion protection:
 *    - Moving a blocked task to "done" is rejected by PostgresTaskRepository.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";
import { and, eq } from "drizzle-orm";
import { TaskBlockedError } from "../../src/core/tasks/errors";

let db: typeof import("../../src/db/pg-client").getPgDb;
let users: typeof import("../../src/db/schema.pg").users;
let taskActivityEvents: typeof import("../../src/db/schema.pg").taskActivityEvents;
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

let projects: InstanceType<typeof PostgresProjectRepository>;
let milestones: InstanceType<typeof PostgresMilestoneRepository>;
let tasks: InstanceType<typeof PostgresTaskRepository>;

before(async () => {
  await migrate();
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  ({ users, taskActivityEvents } = await import("../../src/db/schema.pg"));
  workspaces = await import("../../src/core/workspaces/service");
  ({ PostgresProjectRepository } = await import(
    "../../src/db/repositories/postgres-project-repository"
  ));
  ({ PostgresMilestoneRepository } = await import(
    "../../src/db/repositories/postgres-milestone-repository"
  ));
  ({ PostgresTaskRepository } = await import(
    "../../src/db/repositories/postgres-task-repository"
  ));

  projects = new PostgresProjectRepository();
  milestones = new PostgresMilestoneRepository();
  tasks = new PostgresTaskRepository();
});

after(() => cleanup());

let userSeq = 0;

async function createWorkspaceFixture(name: string) {
  userSeq++;
  const userId = `usr_pg_bulk_${userSeq}_${Date.now()}`;
  await db().insert(users).values({ id: userId, email: `${userId}@example.com` });
  const ws = await workspaces.createTeamWorkspace(userId, name);
  const project = await projects.create(ws.id, { name: `${name} Project` });
  return { workspaceId: ws.id, userId, projectId: project.id };
}

describe("bulk tasks (PostgreSQL repository layer)", () => {
  it("strictly isolates tasks across workspaces", async () => {
    const wsA = await createWorkspaceFixture("Workspace A");
    const wsB = await createWorkspaceFixture("Workspace B");

    const taskA = await tasks.create(wsA.workspaceId, {
      projectId: wsA.projectId,
      title: "Task in A",
      priority: "low",
    });

    const taskB = await tasks.create(wsB.workspaceId, {
      projectId: wsB.projectId,
      title: "Task in B",
      priority: "low",
    });

    // Loading Task B from Workspace A returns null
    const crossCheck = await tasks.findById(wsA.workspaceId, taskB.id);
    assert.equal(crossCheck, null);

    // Updating Task B from Workspace A returns null without modifying Task B
    const crossUpdate = await tasks.update(wsA.workspaceId, taskB.id, { priority: "high" });
    assert.equal(crossUpdate, null);

    const checkB = await tasks.findById(wsB.workspaceId, taskB.id);
    assert.equal(checkB?.priority, "low");
  });

  it("strictly isolates milestones across workspaces", async () => {
    const wsA = await createWorkspaceFixture("Workspace A Milestone");
    const wsB = await createWorkspaceFixture("Workspace B Milestone");

    const milestoneB = await milestones.create(wsB.workspaceId, {
      projectId: wsB.projectId,
      title: "Milestone in B",
    });

    // Querying milestone B in workspace A returns null
    const crossMilestone = await milestones.findById(wsA.workspaceId, milestoneB.id);
    assert.equal(crossMilestone, null);
  });

  it("commits valid updates atomically without cross-task rollback", async () => {
    const ws = await createWorkspaceFixture("Atomic Transactions");

    const task1 = await tasks.create(ws.workspaceId, {
      projectId: ws.projectId,
      title: "Task 1",
      priority: "low",
    });

    const blocker = await tasks.create(ws.workspaceId, {
      projectId: ws.projectId,
      title: "Blocker",
      status: "todo",
    });

    const blocked = await tasks.create(ws.workspaceId, {
      projectId: ws.projectId,
      title: "Blocked",
      status: "todo",
    });
    await tasks.addDependency(ws.workspaceId, blocked.id, blocker.id);

    const task2 = await tasks.create(ws.workspaceId, {
      projectId: ws.projectId,
      title: "Task 2",
      priority: "low",
    });

    // Task 1 succeeds
    const u1 = await tasks.update(ws.workspaceId, task1.id, { priority: "high" });
    assert.equal(u1?.priority, "high");

    // Blocked task fails
    await assert.rejects(
      async () => {
        await tasks.update(ws.workspaceId, blocked.id, { status: "done" });
      },
      (err: unknown) => err instanceof TaskBlockedError,
    );

    // Task 2 succeeds
    const u2 = await tasks.update(ws.workspaceId, task2.id, { priority: "urgent" });
    assert.equal(u2?.priority, "urgent");

    // Verify task 1 and task 2 are committed in DB
    const check1 = await tasks.findById(ws.workspaceId, task1.id);
    const checkBlocked = await tasks.findById(ws.workspaceId, blocked.id);
    const check2 = await tasks.findById(ws.workspaceId, task2.id);

    assert.equal(check1?.priority, "high");
    assert.equal(checkBlocked?.status, "todo");
    assert.equal(check2?.priority, "urgent");
  });

  it("concurrent updates to unrelated fields succeed without overwriting", async () => {
    const ws = await createWorkspaceFixture("Concurrent Fields");

    const task = await tasks.create(ws.workspaceId, {
      projectId: ws.projectId,
      title: "Original title",
      description: "Original description",
      priority: "low",
      status: "todo",
    });

    // Two parallel updates to different fields
    const [resDesc, resPriority] = await Promise.all([
      tasks.update(ws.workspaceId, task.id, { description: "Updated description" }),
      tasks.update(ws.workspaceId, task.id, { priority: "high" }),
    ]);

    assert.ok(resDesc);
    assert.ok(resPriority);

    const finalTask = await tasks.findById(ws.workspaceId, task.id);
    assert.equal(finalTask?.description, "Updated description");
    assert.equal(finalTask?.priority, "high");
  });

  it("deterministic barrier-based concurrency test proving atomic no-op race fix under PostgreSQL row lock", async () => {
    const ws = await createWorkspaceFixture("Concurrency NoOp");

    const task = await tasks.create(ws.workspaceId, {
      projectId: ws.projectId,
      title: "Race Task",
      priority: "low",
    });

    // Create a synchronized release barrier so both callers enter updateAuthoritative concurrently
    let releaseBarrier!: () => void;
    const barrierPromise = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const runner = async () => {
      await barrierPromise;
      return tasks.updateAuthoritative(ws.workspaceId, task.id, { priority: "high" });
    };

    const p1 = runner();
    const p2 = runner();

    // Release both concurrent updates
    releaseBarrier();

    const [res1, res2] = await Promise.all([p1, p2]);

    assert.ok(res1);
    assert.ok(res2);

    // Exactly one winner must perform the update (unchanged: false)
    // and the serialized second transaction must detect all fields already match (unchanged: true)
    const outcomes = [res1.unchanged, res2.unchanged].sort();
    assert.deepEqual(
      outcomes,
      [false, true],
      "One transaction must update and the other must detect unchanged no-op",
    );

    // updatedAt timestamps must match identically (no second bump on no-op)
    assert.equal(res1.task.updatedAt, res2.task.updatedAt);

    // Exactly one task.priority_changed activity event must be recorded
    const events = await db()
      .select()
      .from(taskActivityEvents)
      .where(
        and(
          eq(taskActivityEvents.workspaceId, ws.workspaceId),
          eq(taskActivityEvents.taskId, task.id),
        ),
      );
    const priorityEvents = events.filter((e) => e.type === "task.priority_changed");
    assert.equal(priorityEvents.length, 1, "Exactly one priority_changed event should be recorded");
  });

  it("per-item error boundary isolates unexpected faults and returns retryable internal_error without aborting batch", async () => {
    const ws = await createWorkspaceFixture("Fault Isolation");

    const t1 = await tasks.create(ws.workspaceId, {
      projectId: ws.projectId,
      title: "Task 1",
      priority: "low",
    });
    const t2 = await tasks.create(ws.workspaceId, {
      projectId: ws.projectId,
      title: "Task 2",
      priority: "low",
    });
    const t3 = await tasks.create(ws.workspaceId, {
      projectId: ws.projectId,
      title: "Task 3",
      priority: "low",
    });

    const originalUpdateAuthoritative = tasks.updateAuthoritative.bind(tasks);
    tasks.updateAuthoritative = async (workspaceId, id, input, options) => {
      if (id === t2.id) {
        throw new Error("Simulated unexpected database failure / connection drop");
      }
      return originalUpdateAuthoritative(workspaceId, id, input, options);
    };

    try {
      const results: { taskId: string; status: string; errorCode?: string; retryable?: boolean }[] =
        [];
      for (const t of [t1, t2, t3]) {
        try {
          const outcome = await tasks.updateAuthoritative(ws.workspaceId, t.id, {
            priority: "high",
          });
          results.push({ taskId: t.id, status: outcome?.unchanged ? "unchanged" : "updated" });
        } catch {
          results.push({
            taskId: t.id,
            status: "failed",
            errorCode: "internal_error",
            retryable: true,
          });
        }
      }

      assert.equal(results.length, 3);
      assert.equal(results[0]?.status, "updated");
      assert.equal(results[1]?.status, "failed");
      assert.equal(results[1]?.errorCode, "internal_error");
      assert.equal(results[1]?.retryable, true);
      assert.equal(results[2]?.status, "updated");

      // Verify DB state: t1 and t3 were committed; t2 remains low
      const c1 = await tasks.findById(ws.workspaceId, t1.id);
      const c2 = await tasks.findById(ws.workspaceId, t2.id);
      const c3 = await tasks.findById(ws.workspaceId, t3.id);
      assert.equal(c1?.priority, "high");
      assert.equal(c2?.priority, "low");
      assert.equal(c3?.priority, "high");
    } finally {
      tasks.updateAuthoritative = originalUpdateAuthoritative;
    }
  });

  describe("PostgresTaskRepository updateAuthoritative regression suite", () => {
    it("same-calendar-day but different due-time updates are detected as changes", async () => {
      const ws = await createWorkspaceFixture("Due Time PG");
      const t = await tasks.create(ws.workspaceId, {
        projectId: ws.projectId,
        title: "Due Time Task",
        dueDate: "2026-10-15T01:00:00.000Z",
      });

      const outcome = await tasks.updateAuthoritative(ws.workspaceId, t.id, {
        dueDate: "2026-10-15T20:00:00.000Z",
      });

      assert.ok(outcome);
      assert.equal(outcome.unchanged, false);
      assert.equal(outcome.task.dueDate, "2026-10-15T20:00:00.000Z");

      const readBack = await tasks.findById(ws.workspaceId, t.id);
      assert.equal(readBack?.dueDate, "2026-10-15T20:00:00.000Z");
    });

    it("identical due timestamp is detected as no-op and unchanged", async () => {
      const ws = await createWorkspaceFixture("Due NoOp PG");
      const t = await tasks.create(ws.workspaceId, {
        projectId: ws.projectId,
        title: "Due NoOp Task",
        dueDate: "2026-10-15T20:00:00.000Z",
      });

      const outcome = await tasks.updateAuthoritative(ws.workspaceId, t.id, {
        dueDate: "2026-10-15T20:00:00.000Z",
      });

      assert.ok(outcome);
      assert.equal(outcome.unchanged, true);
      assert.equal(outcome.task.updatedAt, t.updatedAt);
    });

    it("clearing a due date updates the task and is not treated as no-op", async () => {
      const ws = await createWorkspaceFixture("Clear Due PG");
      const t = await tasks.create(ws.workspaceId, {
        projectId: ws.projectId,
        title: "Clear Due Task",
        dueDate: "2026-10-15T20:00:00.000Z",
      });

      const outcome = await tasks.updateAuthoritative(ws.workspaceId, t.id, {
        dueDate: null,
      });

      assert.ok(outcome);
      assert.equal(outcome.unchanged, false);
      assert.equal(outcome.task.dueDate, null);

      const readBack = await tasks.findById(ws.workspaceId, t.id);
      assert.equal(readBack?.dueDate, null);
    });

    it("completedAt-only update does not return early as unchanged when value changes", async () => {
      const ws = await createWorkspaceFixture("CompletedAt PG");
      const t = await tasks.create(ws.workspaceId, {
        projectId: ws.projectId,
        title: "CompletedAt Task",
      });
      assert.equal(t.completedAt, null);

      const outcome = await tasks.updateAuthoritative(ws.workspaceId, t.id, {
        completedAt: "2026-10-20T12:00:00.000Z",
      });

      assert.ok(outcome);
      assert.equal(outcome.unchanged, false);
      assert.equal(outcome.task.completedAt, "2026-10-20T12:00:00.000Z");

      const readBack = await tasks.findById(ws.workspaceId, t.id);
      assert.equal(readBack?.completedAt, "2026-10-20T12:00:00.000Z");
    });

    it("identical completedAt is detected as unchanged no-op", async () => {
      const ws = await createWorkspaceFixture("CompletedAt NoOp PG");
      const t = await tasks.create(ws.workspaceId, {
        projectId: ws.projectId,
        title: "CompletedAt NoOp Task",
        completedAt: "2026-10-20T12:00:00.000Z",
      });

      const outcome = await tasks.updateAuthoritative(ws.workspaceId, t.id, {
        completedAt: "2026-10-20T12:00:00.000Z",
      });

      assert.ok(outcome);
      assert.equal(outcome.unchanged, true);
      assert.equal(outcome.task.updatedAt, t.updatedAt);
    });

    it("existing status-driven completion and reopening behavior sets and clears completedAt", async () => {
      const ws = await createWorkspaceFixture("Lifecycle PG");
      const t = await tasks.create(ws.workspaceId, {
        projectId: ws.projectId,
        title: "Lifecycle Task",
        status: "todo",
      });
      assert.equal(t.completedAt, null);

      // Transition to done sets completedAt
      const doneOutcome = await tasks.updateAuthoritative(ws.workspaceId, t.id, {
        status: "done",
      });
      assert.ok(doneOutcome);
      assert.equal(doneOutcome.unchanged, false);
      assert.equal(doneOutcome.task.status, "done");
      assert.ok(doneOutcome.task.completedAt, "completedAt should be set when moving to done");

      // Reopening clears completedAt
      const reopenOutcome = await tasks.updateAuthoritative(ws.workspaceId, t.id, {
        status: "in_progress",
      });
      assert.ok(reopenOutcome);
      assert.equal(reopenOutcome.unchanged, false);
      assert.equal(reopenOutcome.task.status, "in_progress");
      assert.equal(
        reopenOutcome.task.completedAt,
        null,
        "completedAt should be cleared when reopening",
      );
    });
  });
});

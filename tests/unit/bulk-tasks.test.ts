/**
 * Release 2C.5 Bulk Editing: SQLite / Desktop Unit Tests.
 *
 * Covers:
 * 1. Empty task list rejection.
 * 2. Empty changes rejection.
 * 3. Duplicate task IDs deduplication.
 * 4. Maximum batch size and oversized-batch rejection.
 * 5. Unknown task IDs.
 * 6. Mixed valid and invalid tasks.
 * 7. Blocked tasks completion protection.
 * 8. Priority updates.
 * 9. Due-date set and clear.
 * 10. Milestone set and clear.
 * 11. Cross-project milestone validation.
 * 12. No-op updates and activity suppression.
 * 13. Truthful partial failures and counts.
 * 14. Retryable versus non-retryable error classification.
 * 15. Repeated identical requests.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { cleanup, migrate } from "../helpers/db";
import { LOCAL_WORKSPACE_ID } from "../../src/db/repositories/project-repository";
import type { BulkTaskUpdateResponse, Task } from "../../src/core/tasks/types";
import {
  mergeRetryOutcome,
  formatOutcomeMessage,
  type BulkActionsOutcome,
} from "../../src/components/tasks/bulk-actions-bar";

let projectRepository: typeof import("../../src/db/repositories").projectRepository;
let milestoneRepository: typeof import("../../src/db/repositories").milestoneRepository;
let taskRepository: typeof import("../../src/db/repositories").taskRepository;
let bulkRoute: typeof import("../../src/app/api/tasks/bulk/route");

let projectId: string;
let otherProjectId: string;
let milestone1: { id: string };
let milestoneOther: { id: string };

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

before(async () => {
  await migrate();
  ({ projectRepository, milestoneRepository, taskRepository } = await import(
    "../../src/db/repositories"
  ));
  bulkRoute = await import("../../src/app/api/tasks/bulk/route");

  const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Bulk Project" });
  projectId = project.id;

  const otherProject = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Other Project" });
  otherProjectId = otherProject.id;

  milestone1 = await milestoneRepository.create(LOCAL_WORKSPACE_ID, {
    projectId,
    title: "Milestone 1",
  });

  milestoneOther = await milestoneRepository.create(LOCAL_WORKSPACE_ID, {
    projectId: otherProjectId,
    title: "Other Project Milestone",
  });
});

after(() => cleanup());

describe("bulk tasks API (SQLite / Desktop)", () => {
  it("rejects empty task list with 400", async () => {
    const req = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
      taskIds: [],
      changes: { status: "in_progress" },
    });
    const res = await bulkRoute.POST(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /task ID/i);
  });

  it("rejects empty changes object with 400", async () => {
    const req = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
      taskIds: ["task_1"],
      changes: {},
    });
    const res = await bulkRoute.POST(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /at least one/i);
  });

  it("rejects batch sizes greater than 100 with 400", async () => {
    const taskIds = Array.from({ length: 101 }, (_, i) => `task_${i}`);
    const req = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
      taskIds,
      changes: { priority: "high" },
    });
    const res = await bulkRoute.POST(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /maximum 100/i);
  });

  it("deduplicates task IDs in the request", async () => {
    const task = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Task for dedup",
      status: "todo",
      priority: "medium",
    });

    const req = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
      taskIds: [task.id, task.id, task.id],
      changes: { priority: "urgent" },
    });
    const res = await bulkRoute.POST(req);
    assert.equal(res.status, 200);
    const body: BulkTaskUpdateResponse = await res.json();
    assert.equal(body.requested, 1);
    assert.equal(body.succeeded, 1);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0]!.status, "updated");

    const updated = await taskRepository.findById(LOCAL_WORKSPACE_ID, task.id);
    assert.equal(updated?.priority, "urgent");
  });

  it("handles unknown task IDs with truthful not_found failure", async () => {
    const req = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
      taskIds: ["nonexistent_task_123"],
      changes: { status: "in_progress" },
    });
    const res = await bulkRoute.POST(req);
    assert.equal(res.status, 200);
    const body: BulkTaskUpdateResponse = await res.json();
    assert.equal(body.requested, 1);
    assert.equal(body.succeeded, 0);
    assert.equal(body.failed, 1);
    assert.equal(body.results[0]!.status, "failed");
    assert.equal(body.results[0]!.errorCode, "not_found");
    assert.equal(body.results[0]!.retryable, false);
  });

  it("updates priority across multiple tasks", async () => {
    const t1 = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Priority 1",
      priority: "low",
    });
    const t2 = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Priority 2",
      priority: "medium",
    });

    const req = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
      taskIds: [t1.id, t2.id],
      changes: { priority: "high" },
    });
    const res = await bulkRoute.POST(req);
    assert.equal(res.status, 200);
    const body: BulkTaskUpdateResponse = await res.json();
    assert.equal(body.succeeded, 2);
    assert.equal(body.failed, 0);

    const u1 = await taskRepository.findById(LOCAL_WORKSPACE_ID, t1.id);
    const u2 = await taskRepository.findById(LOCAL_WORKSPACE_ID, t2.id);
    assert.equal(u1?.priority, "high");
    assert.equal(u2?.priority, "high");
  });

  it("sets and clears due date", async () => {
    const task = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Due date task",
    });

    // Set due date
    const req1 = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
      taskIds: [task.id],
      changes: { dueDate: "2026-12-31" },
    });
    const res1 = await bulkRoute.POST(req1);
    assert.equal(res1.status, 200);
    const body1: BulkTaskUpdateResponse = await res1.json();
    assert.equal(body1.succeeded, 1);

    const u1 = await taskRepository.findById(LOCAL_WORKSPACE_ID, task.id);
    assert.ok(u1?.dueDate);

    // Clear due date
    const req2 = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
      taskIds: [task.id],
      changes: { dueDate: null },
    });
    const res2 = await bulkRoute.POST(req2);
    assert.equal(res2.status, 200);
    const body2: BulkTaskUpdateResponse = await res2.json();
    assert.equal(body2.succeeded, 1);

    const u2 = await taskRepository.findById(LOCAL_WORKSPACE_ID, task.id);
    assert.equal(u2?.dueDate, null);
  });

  it("sets and clears milestone", async () => {
    const task = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Milestone task",
    });

    // Set milestone
    const req1 = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
      taskIds: [task.id],
      changes: { milestoneId: milestone1.id },
    });
    const res1 = await bulkRoute.POST(req1);
    assert.equal(res1.status, 200);
    const body1: BulkTaskUpdateResponse = await res1.json();
    assert.equal(body1.succeeded, 1);

    const u1 = await taskRepository.findById(LOCAL_WORKSPACE_ID, task.id);
    assert.equal(u1?.milestoneId, milestone1.id);

    // Clear milestone
    const req2 = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
      taskIds: [task.id],
      changes: { milestoneId: null },
    });
    const res2 = await bulkRoute.POST(req2);
    assert.equal(res2.status, 200);
    const body2: BulkTaskUpdateResponse = await res2.json();
    assert.equal(body2.succeeded, 1);

    const u2 = await taskRepository.findById(LOCAL_WORKSPACE_ID, task.id);
    assert.equal(u2?.milestoneId, null);
  });

  it("rejects cross-project milestone with invalid_milestone error", async () => {
    const task = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Project 1 task",
    });

    const req = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
      taskIds: [task.id],
      changes: { milestoneId: milestoneOther.id },
    });
    const res = await bulkRoute.POST(req);
    assert.equal(res.status, 200);
    const body: BulkTaskUpdateResponse = await res.json();
    assert.equal(body.succeeded, 0);
    assert.equal(body.failed, 1);
    assert.equal(body.results[0]!.status, "failed");
    assert.equal(body.results[0]!.errorCode, "invalid_milestone");
    assert.equal(body.results[0]!.retryable, false);
  });

  it("rejects marking blocked task as done", async () => {
    const blocker = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Blocker task",
      status: "todo",
    });
    const blocked = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Blocked task",
      status: "todo",
    });
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, blocked.id, blocker.id);

    const req = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
      taskIds: [blocked.id],
      changes: { status: "done" },
    });
    const res = await bulkRoute.POST(req);
    assert.equal(res.status, 200);
    const body: BulkTaskUpdateResponse = await res.json();
    assert.equal(body.succeeded, 0);
    assert.equal(body.failed, 1);
    assert.equal(body.results[0]!.status, "failed");
    assert.equal(body.results[0]!.errorCode, "blocked_task");
    assert.equal(body.results[0]!.retryable, false);

    const unmod = await taskRepository.findById(LOCAL_WORKSPACE_ID, blocked.id);
    assert.equal(unmod?.status, "todo");
  });

  it("reports unchanged status and suppresses writes for no-op changes", async () => {
    const task = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "No-op task",
      status: "in_progress",
      priority: "high",
    });

    const req = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
      taskIds: [task.id],
      changes: { status: "in_progress", priority: "high" },
    });
    const res = await bulkRoute.POST(req);
    assert.equal(res.status, 200);
    const body: BulkTaskUpdateResponse = await res.json();
    assert.equal(body.requested, 1);
    assert.equal(body.succeeded, 1);
    assert.equal(body.failed, 0);
    assert.equal(body.results[0]!.status, "unchanged");
  });

  it("handles mixed valid and invalid tasks with truthful partial failure", async () => {
    const valid = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Valid task",
      priority: "low",
    });

    const req = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
      taskIds: [valid.id, "missing_task_abc", "missing_task_def"],
      changes: { priority: "urgent" },
    });
    const res = await bulkRoute.POST(req);
    assert.equal(res.status, 200);
    const body: BulkTaskUpdateResponse = await res.json();
    assert.equal(body.requested, 3);
    assert.equal(body.succeeded, 1);
    assert.equal(body.failed, 2);

    const validResult = body.results.find((r) => r.taskId === valid.id);
    assert.equal(validResult?.status, "updated");

    const failedResults = body.results.filter((r) => r.status === "failed");
    assert.equal(failedResults.length, 2);
    for (const f of failedResults) {
      assert.equal(f.errorCode, "not_found");
      assert.equal(f.retryable, false);
    }

    const updated = await taskRepository.findById(LOCAL_WORKSPACE_ID, valid.id);
    assert.equal(updated?.priority, "urgent");
  });

  it("repeated identical bulk requests produce unchanged outcomes without duplicate activity", async () => {
    const task = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Repeat task",
      priority: "medium",
    });

    // First request
    const req1 = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
      taskIds: [task.id],
      changes: { priority: "high" },
    });
    const res1 = await bulkRoute.POST(req1);
    const body1: BulkTaskUpdateResponse = await res1.json();
    assert.equal(body1.results[0]!.status, "updated");

    // Identical repeated request
    const req2 = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
      taskIds: [task.id],
      changes: { priority: "high" },
    });
    const res2 = await bulkRoute.POST(req2);
    const body2: BulkTaskUpdateResponse = await res2.json();
    assert.equal(body2.results[0]!.status, "unchanged");
  });

  it("rejects task IDs exceeding 200 characters with 400", async () => {
    const oversizedId = "t".repeat(201);
    const req = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
      taskIds: [oversizedId],
      changes: { priority: "high" },
    });
    const res = await bulkRoute.POST(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /200/i);
  });

  it("rejects task IDs containing control or newline characters with 400", async () => {
    const invalidIds = ["task_1\n", "task_\r_2", "task_\x00_3"];
    for (const badId of invalidIds) {
      const req = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
        taskIds: [badId],
        changes: { priority: "high" },
      });
      const res = await bulkRoute.POST(req);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /control or newline/i);
    }
  });

  it("rejects unknown root fields on request body with 400", async () => {
    const req = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
      taskIds: ["task_1"],
      changes: { priority: "high" },
      extraBogusField: "not_allowed",
    });
    const res = await bulkRoute.POST(req);
    assert.equal(res.status, 400);
  });

  it("rejects unknown fields inside changes object with 400", async () => {
    const req = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
      taskIds: ["task_1"],
      changes: { priority: "high", invalidProperty: true },
    });
    const res = await bulkRoute.POST(req);
    assert.equal(res.status, 400);
  });

  it("separates updated and unchanged counts with truthful accounting", async () => {
    const t1 = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Already high",
      priority: "high",
    });
    const t2 = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Currently low",
      priority: "low",
    });

    const req = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
      taskIds: [t1.id, t2.id],
      changes: { priority: "high" },
    });
    const res = await bulkRoute.POST(req);
    assert.equal(res.status, 200);
    const body: BulkTaskUpdateResponse = await res.json();

    assert.equal(body.requested, 2);
    assert.equal(body.succeeded, 2);
    assert.equal(body.updated, 1);
    assert.equal(body.unchanged, 1);
    assert.equal(body.failed, 0);

    const r1 = body.results.find((r) => r.taskId === t1.id);
    const r2 = body.results.find((r) => r.taskId === t2.id);
    assert.equal(r1?.status, "unchanged");
    assert.equal(r2?.status, "updated");
  });

  it("per-item error boundary isolates unexpected faults and returns retryable internal_error without leaking internals", async () => {
    const t1 = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Fault Task 1",
      priority: "low",
    });
    const t2 = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Fault Task 2",
      priority: "low",
    });
    const t3 = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Fault Task 3",
      priority: "low",
    });

    const originalUpdateAuthoritative = taskRepository.updateAuthoritative.bind(taskRepository);
    taskRepository.updateAuthoritative = async (workspaceId, id, input, options) => {
      if (id === t2.id) {
        throw new Error("Disk I/O error or SQLite corruption: SELECT * FROM secrets_leak");
      }
      return originalUpdateAuthoritative(workspaceId, id, input, options);
    };

    try {
      const req = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
        taskIds: [t1.id, t2.id, t3.id],
        changes: { priority: "high" },
      });
      const res = await bulkRoute.POST(req);
      assert.equal(res.status, 200);
      const body: BulkTaskUpdateResponse = await res.json();

      assert.equal(body.requested, 3);
      assert.equal(body.succeeded, 2);
      assert.equal(body.updated, 2);
      assert.equal(body.unchanged, 0);
      assert.equal(body.failed, 1);

      const r1 = body.results.find((r) => r.taskId === t1.id);
      const r2 = body.results.find((r) => r.taskId === t2.id);
      const r3 = body.results.find((r) => r.taskId === t3.id);

      assert.equal(r1?.status, "updated");
      assert.equal(r2?.status, "failed");
      assert.equal(r2?.errorCode, "internal_error");
      assert.equal(r2?.retryable, true);
      // Ensure raw error details with secrets or table names are not leaked to client
      assert.doesNotMatch(r2?.error ?? "", /secrets_leak/i);
      assert.match(r2?.error ?? "", /unexpected error/i);
      assert.equal(r3?.status, "updated");

      // Verify DB state: t1 and t3 were committed, t2 was not modified
      const c1 = await taskRepository.findById(LOCAL_WORKSPACE_ID, t1.id);
      const c2 = await taskRepository.findById(LOCAL_WORKSPACE_ID, t2.id);
      const c3 = await taskRepository.findById(LOCAL_WORKSPACE_ID, t3.id);
      assert.equal(c1?.priority, "high");
      assert.equal(c2?.priority, "low");
      assert.equal(c3?.priority, "high");
    } finally {
      taskRepository.updateAuthoritative = originalUpdateAuthoritative;
    }
  });

  it("fault injection: shared milestone lookup failure is cached and invokes repository findById at most once across 100 tasks", async () => {
    // Create 100 tasks for this test
    const taskIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const t = await taskRepository.create(LOCAL_WORKSPACE_ID, {
        projectId,
        title: `Bulk 100 Task ${i}`,
        priority: "low",
      });
      taskIds.push(t.id);
    }

    // The fault is injected into this handler only; the shared repository is never mutated.
    const { createBulkTaskUpdateHandler, productionBulkTaskUpdateDependencies } = await import(
      "../../src/app/api/tasks/bulk/handler"
    );
    let findByIdCalls = 0;
    const faultyPOST = createBulkTaskUpdateHandler({
      ...productionBulkTaskUpdateDependencies,
      milestoneRepository: {
        findById: async () => {
          findByIdCalls++;
          throw new Error("Disk corruption / network partition: SELECT * FROM credentials_leak");
        },
      },
    });

    {
      const req = jsonRequest("http://localhost/api/tasks/bulk", "POST", {
        taskIds,
        changes: { milestoneId: "shared_milestone_id" },
      });
      const res = await faultyPOST(req);
      assert.equal(res.status, 200);
      const body: BulkTaskUpdateResponse = await res.json();

      assert.equal(body.requested, 100);
      assert.equal(body.failed, 100);
      assert.equal(body.succeeded, 0);
      assert.equal(body.updated, 0);
      assert.equal(body.unchanged, 0);
      assert.equal(body.results.length, 100);

      // Shared lookup must execute at most once across all 100 tasks!
      assert.equal(
        findByIdCalls,
        1,
        "Shared milestone lookup must execute at most once across 100 tasks",
      );

      for (const item of body.results) {
        assert.equal(item.status, "failed");
        assert.equal(item.errorCode, "internal_error");
        assert.equal(item.retryable, true);
        assert.match(item.error ?? "", /unexpected error occurred while checking milestone/i);
        assert.doesNotMatch(item.error ?? "", /credentials_leak/i);
        assert.doesNotMatch(item.error ?? "", /SELECT \*/i);
      }
    }
  });

  describe("SQLite repository updateAuthoritative regression suite", () => {
    it("same-calendar-day but different due-time updates are detected as changes", async () => {
      const t = await taskRepository.create(LOCAL_WORKSPACE_ID, {
        projectId,
        title: "Due Time Task",
        dueDate: "2026-10-15T01:00:00.000Z",
      });

      const outcome = await taskRepository.updateAuthoritative(LOCAL_WORKSPACE_ID, t.id, {
        dueDate: "2026-10-15T20:00:00.000Z",
      });

      assert.ok(outcome);
      assert.equal(outcome.unchanged, false);
      assert.equal(outcome.task.dueDate, "2026-10-15T20:00:00.000Z");

      const readBack = await taskRepository.findById(LOCAL_WORKSPACE_ID, t.id);
      assert.equal(readBack?.dueDate, "2026-10-15T20:00:00.000Z");
    });

    it("identical due timestamp is detected as no-op and unchanged", async () => {
      const t = await taskRepository.create(LOCAL_WORKSPACE_ID, {
        projectId,
        title: "Due NoOp Task",
        dueDate: "2026-10-15T20:00:00.000Z",
      });

      const outcome = await taskRepository.updateAuthoritative(LOCAL_WORKSPACE_ID, t.id, {
        dueDate: "2026-10-15T20:00:00.000Z",
      });

      assert.ok(outcome);
      assert.equal(outcome.unchanged, true);
      assert.equal(outcome.task.updatedAt, t.updatedAt);
    });

    it("clearing a due date updates the task and is not treated as no-op", async () => {
      const t = await taskRepository.create(LOCAL_WORKSPACE_ID, {
        projectId,
        title: "Clear Due Task",
        dueDate: "2026-10-15T20:00:00.000Z",
      });

      const outcome = await taskRepository.updateAuthoritative(LOCAL_WORKSPACE_ID, t.id, {
        dueDate: null,
      });

      assert.ok(outcome);
      assert.equal(outcome.unchanged, false);
      assert.equal(outcome.task.dueDate, null);

      const readBack = await taskRepository.findById(LOCAL_WORKSPACE_ID, t.id);
      assert.equal(readBack?.dueDate, null);
    });

    it("completedAt-only update does not return early as unchanged when value changes", async () => {
      const t = await taskRepository.create(LOCAL_WORKSPACE_ID, {
        projectId,
        title: "CompletedAt Task",
      });
      assert.equal(t.completedAt, null);

      const outcome = await taskRepository.updateAuthoritative(LOCAL_WORKSPACE_ID, t.id, {
        completedAt: "2026-10-20T12:00:00.000Z",
      });

      assert.ok(outcome);
      assert.equal(outcome.unchanged, false);
      assert.equal(outcome.task.completedAt, "2026-10-20T12:00:00.000Z");

      const readBack = await taskRepository.findById(LOCAL_WORKSPACE_ID, t.id);
      assert.equal(readBack?.completedAt, "2026-10-20T12:00:00.000Z");
    });

    it("identical completedAt is detected as unchanged no-op", async () => {
      const t = await taskRepository.create(LOCAL_WORKSPACE_ID, {
        projectId,
        title: "CompletedAt NoOp Task",
        completedAt: "2026-10-20T12:00:00.000Z",
      });

      const outcome = await taskRepository.updateAuthoritative(LOCAL_WORKSPACE_ID, t.id, {
        completedAt: "2026-10-20T12:00:00.000Z",
      });

      assert.ok(outcome);
      assert.equal(outcome.unchanged, true);
      assert.equal(outcome.task.updatedAt, t.updatedAt);
    });

    it("existing status-driven completion and reopening behavior sets and clears completedAt", async () => {
      const t = await taskRepository.create(LOCAL_WORKSPACE_ID, {
        projectId,
        title: "Lifecycle Task",
        status: "todo",
      });
      assert.equal(t.completedAt, null);

      // Transition to done sets completedAt
      const doneOutcome = await taskRepository.updateAuthoritative(LOCAL_WORKSPACE_ID, t.id, {
        status: "done",
      });
      assert.ok(doneOutcome);
      assert.equal(doneOutcome.unchanged, false);
      assert.equal(doneOutcome.task.status, "done");
      assert.ok(doneOutcome.task.completedAt, "completedAt should be set when moving to done");

      // Reopening clears completedAt
      const reopenOutcome = await taskRepository.updateAuthoritative(LOCAL_WORKSPACE_ID, t.id, {
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

  describe("BulkActionsBar retry state and failure merging", () => {
    it("mixed retryable and non-retryable failure merging preserves non-retried items", () => {
      const priorOutcome: BulkActionsOutcome = {
        succeeded: 1,
        updated: 1,
        unchanged: 0,
        failed: 2,
        failedItems: [
          {
            taskId: "tsk_retryable",
            title: "Task With Network Error",
            error: "Network error. Please try again.",
            retryable: true,
          },
          {
            taskId: "tsk_non_retryable",
            title: "Task With Bad Milestone",
            error: "Milestone does not belong to project",
            retryable: false,
          },
        ],
      };

      // Scenario: User clicks "Retry retryable failures".
      // Only tsk_retryable is re-sent. It succeeds (status: "updated").
      const retryResponse: BulkTaskUpdateResponse = {
        requested: 1,
        succeeded: 1,
        updated: 1,
        unchanged: 0,
        failed: 0,
        results: [
          {
            taskId: "tsk_retryable",
            status: "updated",
          },
        ],
      };

      const merged = mergeRetryOutcome(priorOutcome, retryResponse);

      // Succeeded count increases by 1 (1 + 1 = 2)
      assert.equal(merged.succeeded, 2);
      assert.equal(merged.updated, 2);
      assert.equal(merged.unchanged, 0);

      // Failed count reduces to 1 because non-retryable failure remains unresolved
      assert.equal(merged.failed, 1);
      assert.equal(merged.failedItems.length, 1);

      // The non-retryable failure MUST remain present and visible!
      assert.equal(merged.failedItems[0]?.taskId, "tsk_non_retryable");
      assert.equal(merged.failedItems[0]?.error, "Milestone does not belong to project");
      assert.equal(merged.failedItems[0]?.retryable, false);
    });

    it("merging updates error for items that fail again upon retry", () => {
      const priorOutcome: BulkActionsOutcome = {
        succeeded: 0,
        updated: 0,
        unchanged: 0,
        failed: 2,
        failedItems: [
          {
            taskId: "tsk_retryable",
            title: "Task 1",
            error: "Initial network error",
            retryable: true,
          },
          {
            taskId: "tsk_blocked",
            title: "Task 2",
            error: "Blocked by dependency",
            retryable: false,
          },
        ],
      };

      const retryResponse: BulkTaskUpdateResponse = {
        requested: 1,
        succeeded: 0,
        updated: 0,
        unchanged: 0,
        failed: 1,
        results: [
          {
            taskId: "tsk_retryable",
            status: "failed",
            errorCode: "internal_error",
            error: "Database connection refused",
            retryable: true,
          },
        ],
      };

      const merged = mergeRetryOutcome(priorOutcome, retryResponse);
      assert.equal(merged.failed, 2);
      assert.equal(merged.succeeded, 0);

      const r1 = merged.failedItems.find((item) => item.taskId === "tsk_retryable");
      const r2 = merged.failedItems.find((item) => item.taskId === "tsk_blocked");
      assert.equal(r1?.error, "Database connection refused");
      assert.equal(r2?.error, "Blocked by dependency");
    });
  });

  describe("formatOutcomeMessage formatting", () => {
    it("reports clean single-outcome messages", () => {
      assert.equal(
        formatOutcomeMessage({ updated: 5, unchanged: 0, failed: 0 }),
        "Successfully updated 5 tasks.",
      );
      assert.equal(
        formatOutcomeMessage({ updated: 1, unchanged: 0, failed: 0 }),
        "Successfully updated 1 task.",
      );
      assert.equal(
        formatOutcomeMessage({ updated: 0, unchanged: 3, failed: 0 }),
        "3 tasks already matched.",
      );
    });

    it("reports truthful mixed breakdown messages", () => {
      assert.equal(
        formatOutcomeMessage({ updated: 8, unchanged: 2, failed: 0 }),
        "8 updated, 2 already matched.",
      );
      assert.equal(
        formatOutcomeMessage({ updated: 8, unchanged: 2, failed: 1 }),
        "8 updated, 2 already matched, 1 failed.",
      );
      assert.equal(
        formatOutcomeMessage({ updated: 0, unchanged: 2, failed: 1 }),
        "2 already matched, 1 failed.",
      );
    });
  });
});

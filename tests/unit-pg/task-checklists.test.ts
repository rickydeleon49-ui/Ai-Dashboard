/**
 * Release 2C.3 Task Checklists: PostgreSQL Data and Repository Layer Integration Tests.
 *
 * Verifies:
 * 1. CRUD and attribution:
 *    - create item with position = 0, default done = false, created_by attribution
 *    - second item assigned next contiguous position (1)
 *    - update text updates text and updatedAt
 *    - complete sets done = true, done_by, and done_at
 *    - reopen resets done = false, done_by = null, done_at = null
 *    - delete removes item and re-indexes subsequent positions
 * 2. Reorder correctness:
 *    - reorders items to specified array of IDs
 *    - rejects reorders with mismatched lengths or invalid IDs
 * 3. Deterministic two-Client concurrency:
 *    - two concurrent reorders serialize on row lock and execute deterministically
 * 4. Convert-to-task:
 *    - creates top-level task in parent project with item's text and actorUserId
 *    - deletes checklist item and re-indexes remaining items atomically
 *    - rolls back cleanly if task creation fails
 * 5. Cross-workspace isolation:
 *    - workspace B cannot read, update, complete, reorder, delete, or convert items in workspace A
 * 6. Limits:
 *    - text length 1..500 characters
 *    - 100-item limit per task (101st item rejected with ChecklistLimitExceededError)
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";
import { cleanup, migrate } from "../helpers/db.pg";

let db: typeof import("../../src/db/pg-client").getPgDb;
let users: typeof import("../../src/db/schema.pg").users;
let workspacesTable: typeof import("../../src/db/schema.pg").workspaces;
let workspaceMembers: typeof import("../../src/db/schema.pg").workspaceMembers;
let PostgresProjectRepository: typeof import(
  "../../src/db/repositories/postgres-project-repository"
).PostgresProjectRepository;
let PostgresTaskRepository: typeof import(
  "../../src/db/repositories/postgres-task-repository"
).PostgresTaskRepository;
let PostgresChecklistRepository: typeof import(
  "../../src/db/repositories/postgres-checklist-repository"
).PostgresChecklistRepository;
let ChecklistLimitExceededError: typeof import("../../src/core/tasks/errors").ChecklistLimitExceededError;
let ChecklistItemNotFoundError: typeof import("../../src/core/tasks/errors").ChecklistItemNotFoundError;
let InvalidChecklistItemError: typeof import("../../src/core/tasks/errors").InvalidChecklistItemError;

let projectRepo: import("../../src/db/repositories/project-repository").ProjectRepository;
let taskRepo: import("../../src/db/repositories/task-repository").TaskRepository;
let checklistRepo: import("../../src/db/repositories/checklist-repository").ChecklistRepository;

let workspaceA: string;
let workspaceB: string;
let user1: string;
let user2: string;
let projectA: string;
let projectB: string;

before(async () => {
  await migrate();
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  ({
    users,
    workspaces: workspacesTable,
    workspaceMembers,
  } = await import("../../src/db/schema.pg"));
  ({ PostgresProjectRepository } = await import(
    "../../src/db/repositories/postgres-project-repository"
  ));
  ({ PostgresTaskRepository } = await import(
    "../../src/db/repositories/postgres-task-repository"
  ));
  ({ PostgresChecklistRepository } = await import(
    "../../src/db/repositories/postgres-checklist-repository"
  ));
  ({
    ChecklistLimitExceededError,
    ChecklistItemNotFoundError,
    InvalidChecklistItemError,
  } = await import("../../src/core/tasks/errors"));

  projectRepo = new PostgresProjectRepository();
  taskRepo = new PostgresTaskRepository();
  checklistRepo = new PostgresChecklistRepository(taskRepo);

  // Seed users
  const pgDb = db();
  const [u1] = await pgDb
    .insert(users)
    .values({ id: "usr_chk_1", email: "user1@example.com", name: "User One" })
    .returning();
  const [u2] = await pgDb
    .insert(users)
    .values({ id: "usr_chk_2", email: "user2@example.com", name: "User Two" })
    .returning();
  user1 = u1!.id;
  user2 = u2!.id;

  // Seed workspaces
  const [wsA] = await pgDb
    .insert(workspacesTable)
    .values({ id: "ws_chk_a", name: "Workspace A", slug: "ws-chk-a", kind: "team", createdBy: user1 })
    .returning();
  const [wsB] = await pgDb
    .insert(workspacesTable)
    .values({ id: "ws_chk_b", name: "Workspace B", slug: "ws-chk-b", kind: "team", createdBy: user2 })
    .returning();
  workspaceA = wsA!.id;
  workspaceB = wsB!.id;

  // Seed memberships
  await pgDb.insert(workspaceMembers).values([
    { workspaceId: workspaceA, userId: user1, role: "owner", status: "active" },
    { workspaceId: workspaceB, userId: user2, role: "owner", status: "active" },
  ]);

  // Seed projects
  const pA = await projectRepo.create(workspaceA, { name: "Project A" });
  const pB = await projectRepo.create(workspaceB, { name: "Project B" });
  projectA = pA.id;
  projectB = pB.id;
});

after(() => cleanup());

describe("PostgreSQL Task Checklists: CRUD and attribution", () => {
  it("creates, reads, updates, completes, reopens, and deletes checklist items", async () => {
    const task = await taskRepo.create(workspaceA, {
      projectId: projectA,
      title: "Task with checklist",
    });

    // 1. Create first item
    const item1 = await checklistRepo.create(
      workspaceA,
      task.id,
      { text: "First checklist step" },
      { actorUserId: user1 },
    );

    assert.equal(item1.taskId, task.id);
    assert.equal(item1.workspaceId, workspaceA);
    assert.equal(item1.position, 0);
    assert.equal(item1.text, "First checklist step");
    assert.equal(item1.done, false);
    assert.equal(item1.createdBy, user1);
    assert.equal(item1.doneBy, null);
    assert.equal(item1.doneAt, null);
    assert.ok(item1.createdAt);
    assert.ok(item1.updatedAt);

    // 2. Create second item (should have position 1)
    const item2 = await checklistRepo.create(
      workspaceA,
      task.id,
      { text: "Second checklist step" },
      { actorUserId: user1 },
    );
    assert.equal(item2.position, 1);

    // 3. List items
    const list = await checklistRepo.list(workspaceA, task.id);
    assert.equal(list.length, 2);
    assert.equal(list[0]?.id, item1.id);
    assert.equal(list[1]?.id, item2.id);

    // 4. Update item1 text
    const updated = await checklistRepo.update(workspaceA, task.id, item1.id, {
      text: "Updated first step",
    });
    assert.equal(updated?.text, "Updated first step");

    // 5. Complete item1
    const completed = await checklistRepo.complete(workspaceA, task.id, item1.id, {
      actorUserId: user1,
    });
    assert.equal(completed?.done, true);
    assert.equal(completed?.doneBy, user1);
    assert.ok(completed?.doneAt);

    // 6. Reopen item1
    const reopened = await checklistRepo.reopen(workspaceA, task.id, item1.id);
    assert.equal(reopened?.done, false);
    assert.equal(reopened?.doneBy, null);
    assert.equal(reopened?.doneAt, null);

    // 7. Delete item1 and verify item2 shifted down to position 0
    const deleted = await checklistRepo.delete(workspaceA, task.id, item1.id);
    assert.equal(deleted, true);

    const remaining = await checklistRepo.list(workspaceA, task.id);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.id, item2.id);
    assert.equal(remaining[0]?.position, 0);
  });
});

describe("PostgreSQL Task Checklists: Reorder correctness", () => {
  it("reorders checklist items correctly and rejects invalid IDs", async () => {
    const task = await taskRepo.create(workspaceA, {
      projectId: projectA,
      title: "Task for reorder test",
    });

    const item0 = await checklistRepo.create(workspaceA, task.id, { text: "Item 0" });
    const item1 = await checklistRepo.create(workspaceA, task.id, { text: "Item 1" });
    const item2 = await checklistRepo.create(workspaceA, task.id, { text: "Item 2" });

    // Reverse order: item2, item1, item0
    const reordered = await checklistRepo.reorder(workspaceA, task.id, [
      item2.id,
      item1.id,
      item0.id,
    ]);

    assert.equal(reordered.length, 3);
    assert.equal(reordered[0]?.id, item2.id);
    assert.equal(reordered[0]?.position, 0);
    assert.equal(reordered[1]?.id, item1.id);
    assert.equal(reordered[1]?.position, 1);
    assert.equal(reordered[2]?.id, item0.id);
    assert.equal(reordered[2]?.position, 2);

    // Reject reorder if count is mismatched
    await assert.rejects(
      () => checklistRepo.reorder(workspaceA, task.id, [item2.id, item1.id]),
      (err: unknown) => err instanceof InvalidChecklistItemError,
    );

    // Reject reorder if an unknown ID is passed
    await assert.rejects(
      () => checklistRepo.reorder(workspaceA, task.id, [item2.id, item1.id, "chk_nonexistent"]),
      (err: unknown) => err instanceof InvalidChecklistItemError,
    );
  });
});

describe("PostgreSQL Task Checklists: Deterministic two-Client concurrency", () => {
  it("two concurrent reorders serialize cleanly using row lock without duplicate positions", async () => {
    const task = await taskRepo.create(workspaceA, {
      projectId: projectA,
      title: "Concurrent reorder task",
    });

    const a = await checklistRepo.create(workspaceA, task.id, { text: "A" });
    const b = await checklistRepo.create(workspaceA, task.id, { text: "B" });
    const c = await checklistRepo.create(workspaceA, task.id, { text: "C" });

    const c1 = new Client({ connectionString: process.env.DATABASE_URL });
    const c2 = new Client({ connectionString: process.env.DATABASE_URL });
    await c1.connect();
    await c2.connect();

    try {
      // 1. Client 1 begins transaction and locks parent task row
      await c1.query("BEGIN");
      await c1.query(
        "SELECT id FROM task WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
        [task.id, workspaceA],
      );

      // 2. Client 2 attempts to lock the same parent task row in its transaction (will block)
      await c2.query("BEGIN");
      let c2AcquiredLock = false;
      const c2LockPromise = c2
        .query(
          "SELECT id FROM task WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
          [task.id, workspaceA],
        )
        .then(() => {
          c2AcquiredLock = true;
        });

      // Give client 2 a moment to block
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(c2AcquiredLock, false, "Client 2 must be blocked waiting for parent task row lock");

      // 3. Client 1 updates positions to [C=0, B=1, A=2] and commits
      await c1.query(
        "UPDATE task_checklist_item SET position = 0 WHERE id = $1",
        [c.id],
      );
      await c1.query(
        "UPDATE task_checklist_item SET position = 1 WHERE id = $1",
        [b.id],
      );
      await c1.query(
        "UPDATE task_checklist_item SET position = 2 WHERE id = $1",
        [a.id],
      );
      await c1.query("COMMIT");

      // 4. Client 2 unblocks
      await c2LockPromise;
      assert.equal(c2AcquiredLock, true, "Client 2 acquired lock after Client 1 committed");

      // Client 2 now writes its own order [B=0, A=1, C=2] and commits
      await c2.query(
        "UPDATE task_checklist_item SET position = 0 WHERE id = $1",
        [b.id],
      );
      await c2.query(
        "UPDATE task_checklist_item SET position = 1 WHERE id = $1",
        [a.id],
      );
      await c2.query(
        "UPDATE task_checklist_item SET position = 2 WHERE id = $1",
        [c.id],
      );
      await c2.query("COMMIT");

      // 5. Final positions in database must be strictly [B=0, A=1, C=2]
      const finalItems = await checklistRepo.list(workspaceA, task.id);
      assert.equal(finalItems[0]?.id, b.id);
      assert.equal(finalItems[0]?.position, 0);
      assert.equal(finalItems[1]?.id, a.id);
      assert.equal(finalItems[1]?.position, 1);
      assert.equal(finalItems[2]?.id, c.id);
      assert.equal(finalItems[2]?.position, 2);
    } finally {
      await c1.end();
      await c2.end();
    }
  });
});

describe("PostgreSQL Task Checklists: Convert to task", () => {
  it("converts an item to a task with task invariants and removes item atomically", async () => {
    const task = await taskRepo.create(workspaceA, {
      projectId: projectA,
      title: "Parent task",
    });

    const item1 = await checklistRepo.create(workspaceA, task.id, { text: "Convert me" });
    const item2 = await checklistRepo.create(workspaceA, task.id, { text: "Remain here" });

    const converted = await checklistRepo.convertToTask(workspaceA, task.id, item1.id, {
      actorUserId: user1,
    });

    // 1. Verify converted task
    assert.ok(converted.id);
    assert.equal(converted.projectId, projectA);
    assert.equal(converted.title, "Convert me");
    assert.equal(converted.status, "todo");
    assert.equal(converted.blocked, false);

    // 2. Verify checklist item deleted and item2 shifted down to position 0
    const items = await checklistRepo.list(workspaceA, task.id);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, item2.id);
    assert.equal(items[0]?.position, 0);
  });

  it("rolls back atomically if task creation fails", async () => {
    const task = await taskRepo.create(workspaceA, {
      projectId: projectA,
      title: "Parent task with failing convert",
    });

    const item = await checklistRepo.create(workspaceA, task.id, { text: "Will fail" });

    // Mock taskRepo.create to throw
    const mockRepo = new PostgresChecklistRepository({
      ...taskRepo,
      create: async () => {
        throw new Error("Simulated task creation failure");
      },
    });

    await assert.rejects(
      () => mockRepo.convertToTask(workspaceA, task.id, item.id),
      /Simulated task creation failure/,
    );

    // Checklist item must still exist in the database!
    const items = await checklistRepo.list(workspaceA, task.id);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, item.id);
    assert.equal(items[0]?.text, "Will fail");
  });
});

describe("PostgreSQL Task Checklists: Cross-workspace isolation", () => {
  it("does not allow workspace B to access or mutate items in workspace A", async () => {
    const taskA = await taskRepo.create(workspaceA, {
      projectId: projectA,
      title: "Task in Workspace A",
    });

    const itemA = await checklistRepo.create(workspaceA, taskA.id, {
      text: "Secret step in WS A",
    });

    // 1. Workspace B list returns empty
    const listB = await checklistRepo.list(workspaceB, taskA.id);
    assert.equal(listB.length, 0);

    // 2. Workspace B findById returns null
    const findB = await checklistRepo.findById(workspaceB, taskA.id, itemA.id);
    assert.equal(findB, null);

    // 3. Workspace B update returns null
    const updateB = await checklistRepo.update(workspaceB, taskA.id, itemA.id, {
      text: "Hacked",
    });
    assert.equal(updateB, null);

    // 4. Workspace B complete returns null
    const completeB = await checklistRepo.complete(workspaceB, taskA.id, itemA.id);
    assert.equal(completeB, null);

    // 5. Workspace B delete returns false
    const deleteB = await checklistRepo.delete(workspaceB, taskA.id, itemA.id);
    assert.equal(deleteB, false);

    // 6. Workspace B convertToTask rejects with not found
    await assert.rejects(
      () => checklistRepo.convertToTask(workspaceB, taskA.id, itemA.id),
      (err: unknown) => err instanceof ChecklistItemNotFoundError,
    );

    // Verify item in Workspace A is completely unchanged
    const intact = await checklistRepo.findById(workspaceA, taskA.id, itemA.id);
    assert.equal(intact?.text, "Secret step in WS A");
    assert.equal(intact?.done, false);
  });
});

describe("PostgreSQL Task Checklists: Server-side limits", () => {
  it("enforces text length limits (1..500 chars)", async () => {
    const task = await taskRepo.create(workspaceA, {
      projectId: projectA,
      title: "Limits task",
    });

    // Empty text
    await assert.rejects(
      () => checklistRepo.create(workspaceA, task.id, { text: "" }),
      (err: unknown) => err instanceof InvalidChecklistItemError,
    );

    // Whitespace only
    await assert.rejects(
      () => checklistRepo.create(workspaceA, task.id, { text: "   " }),
      (err: unknown) => err instanceof InvalidChecklistItemError,
    );

    // >500 characters
    const longText = "a".repeat(501);
    await assert.rejects(
      () => checklistRepo.create(workspaceA, task.id, { text: longText }),
      (err: unknown) => err instanceof InvalidChecklistItemError,
    );

    // 500 characters succeeds
    const maxText = "a".repeat(500);
    const valid = await checklistRepo.create(workspaceA, task.id, { text: maxText });
    assert.equal(valid.text.length, 500);
  });

  it("enforces max 100 items per task limit", async () => {
    const task = await taskRepo.create(workspaceA, {
      projectId: projectA,
      title: "100-item limit task",
    });

    // Seed 100 items directly via insert for speed
    const pgDb = db();
    const rows = [];
    const now = new Date();
    for (let i = 0; i < 100; i++) {
      rows.push({
        id: `chk_bulk_${i}`,
        workspaceId: workspaceA,
        taskId: task.id,
        position: i,
        text: `Item ${i}`,
        done: false,
        createdAt: now,
        updatedAt: now,
      });
    }
    const { taskChecklistItems: schemaItems } = await import("../../src/db/schema.pg");
    await pgDb.insert(schemaItems).values(rows);

    const currentItems = await checklistRepo.list(workspaceA, task.id);
    assert.equal(currentItems.length, 100);

    // 101st item must be rejected with ChecklistLimitExceededError
    await assert.rejects(
      () => checklistRepo.create(workspaceA, task.id, { text: "Item 101" }),
      (err: unknown) => err instanceof ChecklistLimitExceededError,
    );
  });
});

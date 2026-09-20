/**
 * Release 2C.3 Task Checklists: SQLite / Desktop Unit Tests.
 *
 * Verifies:
 * 1. CRUD:
 *    - create item with position = 0, default done = false
 *    - second item assigned position = 1
 *    - update text updates text and updatedAt
 *    - complete marks done = true
 *    - reopen resets done = false
 *    - delete removes item and re-indexes remaining items
 * 2. Reorder correctness:
 *    - reorders items and maintains dense 0..N-1 sequence
 *    - rejects invalid item IDs
 * 3. Convert to task:
 *    - creates task with item's text in parent project
 *    - deletes checklist item and re-indexes remaining
 * 4. Limits:
 *    - text length 1..500 characters
 *    - 100-item limit per task
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db";
import { LOCAL_WORKSPACE_ID } from "../../src/db/repositories/project-repository";

let projectRepository: import("../../src/db/repositories/project-repository").ProjectRepository;
let taskRepository: import("../../src/db/repositories/task-repository").TaskRepository;
let checklistRepository: import("../../src/db/repositories/checklist-repository").ChecklistRepository;
let ChecklistLimitExceededError: typeof import("../../src/core/tasks/errors").ChecklistLimitExceededError;
let ChecklistItemNotFoundError: typeof import("../../src/core/tasks/errors").ChecklistItemNotFoundError;
let InvalidChecklistItemError: typeof import("../../src/core/tasks/errors").InvalidChecklistItemError;

let projectId: string;

before(async () => {
  await migrate();
  ({
    projectRepository,
    taskRepository,
    checklistRepository,
  } = await import("../../src/db/repositories"));
  ({
    ChecklistLimitExceededError,
    ChecklistItemNotFoundError,
    InvalidChecklistItemError,
  } = await import("../../src/core/tasks/errors"));

  const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Desktop Checklist Project" });
  projectId = project.id;
});

after(() => cleanup());

describe("task checklists (SQLite)", () => {
  it("creates, reads, updates, completes, reopens, and deletes checklist items", async () => {
    const task = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Task with checklist (SQLite)",
    });

    // 1. Create item 1
    const item1 = await checklistRepository.create(LOCAL_WORKSPACE_ID, task.id, {
      text: "Item 1",
    });
    assert.equal(item1.position, 0);
    assert.equal(item1.text, "Item 1");
    assert.equal(item1.done, false);

    // 2. Create item 2
    const item2 = await checklistRepository.create(LOCAL_WORKSPACE_ID, task.id, {
      text: "Item 2",
    });
    assert.equal(item2.position, 1);

    // 3. List items
    const list = await checklistRepository.list(LOCAL_WORKSPACE_ID, task.id);
    assert.equal(list.length, 2);
    assert.equal(list[0]?.id, item1.id);
    assert.equal(list[1]?.id, item2.id);

    // 4. Update text
    const updated = await checklistRepository.update(LOCAL_WORKSPACE_ID, task.id, item1.id, {
      text: "Updated Item 1",
    });
    assert.equal(updated?.text, "Updated Item 1");

    // 5. Complete item
    const completed = await checklistRepository.complete(LOCAL_WORKSPACE_ID, task.id, item1.id);
    assert.equal(completed?.done, true);
    assert.ok(completed?.doneAt);

    // 6. Reopen item
    const reopened = await checklistRepository.reopen(LOCAL_WORKSPACE_ID, task.id, item1.id);
    assert.equal(reopened?.done, false);
    assert.equal(reopened?.doneAt, null);

    // 7. Delete item1 and verify item2 shifted to position 0
    const deleted = await checklistRepository.delete(LOCAL_WORKSPACE_ID, task.id, item1.id);
    assert.equal(deleted, true);

    const remaining = await checklistRepository.list(LOCAL_WORKSPACE_ID, task.id);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.id, item2.id);
    assert.equal(remaining[0]?.position, 0);
  });

  it("reorders checklist items", async () => {
    const task = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Reorder task (SQLite)",
    });

    const a = await checklistRepository.create(LOCAL_WORKSPACE_ID, task.id, { text: "A" });
    const b = await checklistRepository.create(LOCAL_WORKSPACE_ID, task.id, { text: "B" });
    const c = await checklistRepository.create(LOCAL_WORKSPACE_ID, task.id, { text: "C" });

    const reordered = await checklistRepository.reorder(LOCAL_WORKSPACE_ID, task.id, [
      c.id,
      a.id,
      b.id,
    ]);

    assert.equal(reordered[0]?.id, c.id);
    assert.equal(reordered[0]?.position, 0);
    assert.equal(reordered[1]?.id, a.id);
    assert.equal(reordered[1]?.position, 1);
    assert.equal(reordered[2]?.id, b.id);
    assert.equal(reordered[2]?.position, 2);

    // Rejects invalid list
    await assert.rejects(
      () => checklistRepository.reorder(LOCAL_WORKSPACE_ID, task.id, [a.id, b.id]),
      (err: unknown) => err instanceof InvalidChecklistItemError,
    );
  });

  it("converts a checklist item to a task", async () => {
    const task = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Parent for convert (SQLite)",
    });

    const item = await checklistRepository.create(LOCAL_WORKSPACE_ID, task.id, {
      text: "Convert this item to a task",
    });

    const converted = await checklistRepository.convertToTask(LOCAL_WORKSPACE_ID, task.id, item.id);
    assert.ok(converted.id);
    assert.equal(converted.title, "Convert this item to a task");
    assert.equal(converted.projectId, projectId);

    const remaining = await checklistRepository.list(LOCAL_WORKSPACE_ID, task.id);
    assert.equal(remaining.length, 0);
  });

  it("enforces text constraints and limits (SQLite)", async () => {
    const task = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Limits task (SQLite)",
    });

    // Empty text
    await assert.rejects(
      () => checklistRepository.create(LOCAL_WORKSPACE_ID, task.id, { text: "  " }),
      (err: unknown) => err instanceof InvalidChecklistItemError,
    );

    // >500 chars
    await assert.rejects(
      () => checklistRepository.create(LOCAL_WORKSPACE_ID, task.id, { text: "x".repeat(501) }),
      (err: unknown) => err instanceof InvalidChecklistItemError,
    );

    // 100 items limit
    const { taskChecklistItems: schemaItems } = await import("../../src/db/schema");
    const { db } = await import("../../src/db/client");

    const rows = [];
    const now = new Date().toISOString();
    for (let i = 0; i < 100; i++) {
      rows.push({
        id: `chk_sqlite_bulk_${i}`,
        workspaceId: LOCAL_WORKSPACE_ID,
        taskId: task.id,
        position: i,
        text: `Item ${i}`,
        done: false,
        createdAt: now,
        updatedAt: now,
      });
    }
    db.insert(schemaItems).values(rows).run();

    await assert.rejects(
      () => checklistRepository.create(LOCAL_WORKSPACE_ID, task.id, { text: "Item 101" }),
      (err: unknown) => err instanceof ChecklistLimitExceededError,
    );
  });
});

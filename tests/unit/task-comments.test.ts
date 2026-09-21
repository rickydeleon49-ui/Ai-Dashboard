/**
 * Task comments and activity history against a throwaway SQLite database — desktop mode.
 *
 * Verifies:
 * 1. Comment CRUD & edit history on SQLite.
 * 2. Soft-deletion preserving history on SQLite.
 * 3. Rejection of mentions on desktop mode (single-user, no workspace members).
 * 4. Activity events logged on desktop SQLite.
 * 5. Stored-XSS: raw payload stored verbatim without execution.
 * 6. Idempotency: repeating idempotent operations emits zero additional activity events.
 * 7. Desktop atomic checklist conversion with deterministic fault injection.
 * 8. Cursor pagination and bounded edit counts.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { inArray } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db";
import { LOCAL_WORKSPACE_ID } from "../../src/db/repositories/project-repository";
import { DrizzleChecklistRepository } from "../../src/db/repositories/drizzle-checklist-repository";
import { db } from "../../src/db/client";
import { taskComments } from "../../src/db/schema";

let projectRepository: import("../../src/db/repositories/project-repository").ProjectRepository;
let taskRepository: import("../../src/db/repositories/task-repository").TaskRepository;
let commentRepository: import("../../src/db/repositories/comment-repository").CommentRepository;
let activityRepository: import("../../src/db/repositories/activity-repository").ActivityRepository;
let checklistRepository: DrizzleChecklistRepository;

let InvalidMentionError: typeof import("../../src/core/tasks/errors").InvalidMentionError;
let InvalidCommentError: typeof import("../../src/core/tasks/errors").InvalidCommentError;
let InvalidPaginationError: typeof import("../../src/core/tasks/errors").InvalidPaginationError;

let projectId: string;
let taskId: string;

before(async () => {
  await migrate();
  ({ projectRepository, taskRepository, commentRepository, activityRepository } = await import(
    "../../src/db/repositories"
  ));
  checklistRepository = new DrizzleChecklistRepository(taskRepository);
  ({ InvalidMentionError, InvalidCommentError, InvalidPaginationError } = await import(
    "../../src/core/tasks/errors"
  ));

  const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Desktop Project" });
  projectId = project.id;

  const task = await taskRepository.create(LOCAL_WORKSPACE_ID, {
    projectId,
    title: "Desktop Task 1",
  });
  taskId = task.id;
});

after(() => cleanup());

describe("Task Comments & Activity (SQLite / Desktop)", () => {
  let createdCommentId: string;

  it("creates a comment and logs activity event in SQLite", async () => {
    const comment = await commentRepository.create(LOCAL_WORKSPACE_ID, taskId, {
      body: "Desktop task comment",
    });

    assert.ok(comment.id);
    assert.equal(comment.taskId, taskId);
    assert.equal(comment.body, "Desktop task comment");
    assert.equal(comment.authorId, null);
    assert.equal(comment.isDeleted, false);
    assert.equal(comment.editCount, 0);

    createdCommentId = comment.id;

    const events = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, taskId);
    const commentEvent = events.find((e) => e.type === "comment.created");
    assert.ok(commentEvent);
    assert.equal(commentEvent.details.commentId, comment.id);
  });

  it("lists comments in chronological order with pagination envelope", async () => {
    const comment2 = await commentRepository.create(LOCAL_WORKSPACE_ID, taskId, {
      body: "Second desktop comment",
    });

    const page = await commentRepository.list(LOCAL_WORKSPACE_ID, taskId);
    assert.equal(page.comments.length, 2);
    assert.equal(page.comments[0]?.id, createdCommentId);
    assert.equal(page.comments[1]?.id, comment2.id);
    assert.equal(page.nextCursor, null);
  });

  it("paginates comments with stable cursor and bounded limits", async () => {
    // Add 3 more comments
    for (let i = 1; i <= 3; i++) {
      await commentRepository.create(LOCAL_WORKSPACE_ID, taskId, {
        body: `Pagination test comment ${i}`,
      });
    }

    // Page 1: limit 2
    const page1 = await commentRepository.list(LOCAL_WORKSPACE_ID, taskId, { limit: 2 });
    assert.equal(page1.comments.length, 2);
    assert.ok(page1.nextCursor);

    // Page 2: limit 2 with cursor
    const page2 = await commentRepository.list(LOCAL_WORKSPACE_ID, taskId, {
      limit: 2,
      cursor: page1.nextCursor,
    });
    assert.equal(page2.comments.length, 2);
    assert.notEqual(page1.comments[0]?.id, page2.comments[0]?.id);
    assert.ok(page2.nextCursor);

    // Page 3: limit 2 with cursor
    const page3 = await commentRepository.list(LOCAL_WORKSPACE_ID, taskId, {
      limit: 2,
      cursor: page2.nextCursor,
    });
    assert.equal(page3.comments.length, 1);
    assert.equal(page3.nextCursor, null);
  });

  it("preserves stable ordering and pagination across equal timestamps (createdAt ASC, id ASC)", async () => {
    const timestampTask = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Same Timestamp Task",
    });

    const c1 = await commentRepository.create(LOCAL_WORKSPACE_ID, timestampTask.id, {
      body: "Comment timestamp A",
    });
    const c2 = await commentRepository.create(LOCAL_WORKSPACE_ID, timestampTask.id, {
      body: "Comment timestamp B",
    });

    // Force exact identical createdAt timestamp
    const fixedTime = "2026-09-20T12:00:00.000Z";
    db.update(taskComments)
      .set({ createdAt: fixedTime })
      .where(inArray(taskComments.id, [c1.id, c2.id]))
      .run();

    const expectedOrder = [c1.id, c2.id].sort();
    const firstId = expectedOrder[0]!;
    const secondId = expectedOrder[1]!;

    // Fetch page 1 with limit 1
    const p1 = await commentRepository.list(LOCAL_WORKSPACE_ID, timestampTask.id, { limit: 1 });
    assert.equal(p1.comments.length, 1);
    assert.equal(p1.comments[0]?.id, firstId);
    assert.ok(p1.nextCursor);

    // Fetch page 2 with limit 1 and cursor
    const p2 = await commentRepository.list(LOCAL_WORKSPACE_ID, timestampTask.id, {
      limit: 1,
      cursor: p1.nextCursor,
    });
    assert.equal(p2.comments.length, 1);
    assert.equal(p2.comments[0]?.id, secondId);
    assert.equal(p2.nextCursor, null);
  });

  it("throws InvalidPaginationError on malformed cursor and never silently restarts", async () => {
    await assert.rejects(async () => {
      await commentRepository.list(LOCAL_WORKSPACE_ID, taskId, {
        cursor: "not-valid-base64url!@#",
      });
    }, InvalidPaginationError);

    await assert.rejects(async () => {
      await commentRepository.list(LOCAL_WORKSPACE_ID, taskId, {
        cursor: Buffer.from("invalid-json").toString("base64url"),
      });
    }, InvalidPaginationError);
  });

  it("updates a comment and records previous body in edit history", async () => {
    const updated = await commentRepository.update(LOCAL_WORKSPACE_ID, taskId, createdCommentId, {
      body: "Updated desktop comment body",
    });

    assert.ok(updated);
    assert.equal(updated.body, "Updated desktop comment body");
    assert.equal(updated.editCount, 1);

    const history = await commentRepository.getEditHistory(LOCAL_WORKSPACE_ID, taskId, createdCommentId);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.previousBody, "Desktop task comment");

    const events = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, taskId);
    const editEvent = events.find((e) => e.type === "comment.edited");
    assert.ok(editEvent);
  });

  it("soft-deletes a comment redacting author and body on normal endpoints", async () => {
    const deleted = await commentRepository.delete(LOCAL_WORKSPACE_ID, taskId, createdCommentId);
    assert.equal(deleted, true);

    const fetched = await commentRepository.findById(LOCAL_WORKSPACE_ID, taskId, createdCommentId);
    assert.ok(fetched);
    assert.equal(fetched.isDeleted, true);
    assert.equal(fetched.body, "[This comment was deleted]");
    assert.equal(fetched.authorId, null);
    assert.equal(fetched.deletedBy, null);
    assert.ok(fetched.deletedAt);

    // Edit history remains in repository for privileged audit
    const history = await commentRepository.getEditHistory(LOCAL_WORKSPACE_ID, taskId, createdCommentId);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.previousBody, "Desktop task comment");

    // Editing a deleted comment throws
    await assert.rejects(async () => {
      await commentRepository.update(LOCAL_WORKSPACE_ID, taskId, createdCommentId, {
        body: "Should fail",
      });
    }, InvalidCommentError);
  });

  it("rejects mentions in desktop mode", async () => {
    await assert.rejects(async () => {
      await commentRepository.create(LOCAL_WORKSPACE_ID, taskId, {
        body: "Hello @11111111-1111-1111-1111-111111111111",
      });
    }, InvalidMentionError);

    await assert.rejects(async () => {
      await commentRepository.create(LOCAL_WORKSPACE_ID, taskId, {
        body: "Hello @[Someone](11111111-1111-1111-1111-111111111111)",
      });
    }, InvalidMentionError);
  });

  it("stores raw payload verbatim without executing script tags", async () => {
    const xss = "<script>alert('desktop-xss')</script>";
    const comment = await commentRepository.create(LOCAL_WORKSPACE_ID, taskId, {
      body: xss,
    });

    assert.equal(comment.body, xss);
    // Preserved verbatim in database
    const read = await commentRepository.findById(LOCAL_WORKSPACE_ID, taskId, comment.id);
    assert.equal(read?.body, xss);
  });

  it("emits activity events only for real state transitions (no duplicate events on repeated no-ops)", async () => {
    const otherTask = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Dependency Blocker Task",
    });

    // 1. Dependency addition
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, taskId, otherTask.id);
    const eventsAfterAdd1 = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, taskId);
    const addEventsCount1 = eventsAfterAdd1.filter((e) => e.type === "task.dependency_added").length;
    assert.equal(addEventsCount1, 1);

    // Repeat dependency addition (no-op)
    await taskRepository.addDependency(LOCAL_WORKSPACE_ID, taskId, otherTask.id);
    const eventsAfterAdd2 = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, taskId);
    const addEventsCount2 = eventsAfterAdd2.filter((e) => e.type === "task.dependency_added").length;
    assert.equal(addEventsCount2, 1, "Idempotent dependency add must not create another activity event");

    // 2. Dependency removal
    await taskRepository.removeDependency(LOCAL_WORKSPACE_ID, taskId, otherTask.id);
    const eventsAfterRem1 = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, taskId);
    const remEventsCount1 = eventsAfterRem1.filter((e) => e.type === "task.dependency_removed").length;
    assert.equal(remEventsCount1, 1);

    // Repeat dependency removal (no-op)
    await taskRepository.removeDependency(LOCAL_WORKSPACE_ID, taskId, otherTask.id);
    const eventsAfterRem2 = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, taskId);
    const remEventsCount2 = eventsAfterRem2.filter((e) => e.type === "task.dependency_removed").length;
    assert.equal(remEventsCount2, 1, "Idempotent dependency removal must not create another activity event");

    // 3. Checklist complete and reopen transitions
    const checkItem = await checklistRepository.create(LOCAL_WORKSPACE_ID, taskId, { text: "Test transition item" });

    // Complete transition (false -> true)
    await checklistRepository.complete(LOCAL_WORKSPACE_ID, taskId, checkItem.id);
    const eventsAfterComp1 = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, taskId);
    const compEventsCount1 = eventsAfterComp1.filter((e) => e.type === "checklist.item_completed").length;
    assert.equal(compEventsCount1, 1);

    // Repeat complete (true -> true, no-op)
    await checklistRepository.complete(LOCAL_WORKSPACE_ID, taskId, checkItem.id);
    const eventsAfterComp2 = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, taskId);
    const compEventsCount2 = eventsAfterComp2.filter((e) => e.type === "checklist.item_completed").length;
    assert.equal(compEventsCount2, 1, "Idempotent checklist complete must not create another activity event");

    // Reopen transition (true -> false)
    await checklistRepository.reopen(LOCAL_WORKSPACE_ID, taskId, checkItem.id);
    const eventsAfterReopen1 = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, taskId);
    const reopenEventsCount1 = eventsAfterReopen1.filter((e) => e.type === "checklist.item_reopened").length;
    assert.equal(reopenEventsCount1, 1);

    // Repeat reopen (false -> false, no-op)
    await checklistRepository.reopen(LOCAL_WORKSPACE_ID, taskId, checkItem.id);
    const eventsAfterReopen2 = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, taskId);
    const reopenEventsCount2 = eventsAfterReopen2.filter((e) => e.type === "checklist.item_reopened").length;
    assert.equal(reopenEventsCount2, 1, "Idempotent checklist reopen must not create another activity event");
  });

  describe("Desktop atomic checklist conversion fault injection", () => {
    it("rolls back completely on fault during checklist item deletion", async () => {
      const conversionTask = await taskRepository.create(LOCAL_WORKSPACE_ID, {
        projectId,
        title: "Task with items for conversion",
      });
      const item1 = await checklistRepository.create(LOCAL_WORKSPACE_ID, conversionTask.id, { text: "Convert item 1" });
      const item2 = await checklistRepository.create(LOCAL_WORKSPACE_ID, conversionTask.id, { text: "Convert item 2" });

      const initialTasks = await taskRepository.list(LOCAL_WORKSPACE_ID, projectId);
      const initialTaskCount = initialTasks.length;
      const initialEvents = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, conversionTask.id);

      // Inject fault at delete stage
      checklistRepository.__testFaultHook = (stage) => {
        if (stage === "delete") {
          throw new Error("Simulated fault at checklist deletion");
        }
      };

      await assert.rejects(async () => {
        await checklistRepository.convertToTask(LOCAL_WORKSPACE_ID, conversionTask.id, item1.id);
      }, /Simulated fault at checklist deletion/);

      checklistRepository.__testFaultHook = undefined;

      // Assert state is untouched
      const tasksAfter = await taskRepository.list(LOCAL_WORKSPACE_ID, projectId);
      assert.equal(tasksAfter.length, initialTaskCount, "No orphan task should exist");

      const itemsAfter = await checklistRepository.list(LOCAL_WORKSPACE_ID, conversionTask.id);
      assert.equal(itemsAfter.length, 2, "Both checklist items must remain");
      assert.equal(itemsAfter[0]?.id, item1.id);
      assert.equal(itemsAfter[0]?.position, 0);
      assert.equal(itemsAfter[1]?.id, item2.id);
      assert.equal(itemsAfter[1]?.position, 1);

      const eventsAfter = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, conversionTask.id);
      assert.equal(eventsAfter.length, initialEvents.length, "No false activity event should be created");
    });

    it("rolls back completely on fault during position reindexing", async () => {
      const conversionTask = await taskRepository.create(LOCAL_WORKSPACE_ID, {
        projectId,
        title: "Task with items for reindexing fault",
      });
      const item1 = await checklistRepository.create(LOCAL_WORKSPACE_ID, conversionTask.id, { text: "Reindex item 1" });
      const item2 = await checklistRepository.create(LOCAL_WORKSPACE_ID, conversionTask.id, { text: "Reindex item 2" });

      const initialTasks = await taskRepository.list(LOCAL_WORKSPACE_ID, projectId);
      const initialTaskCount = initialTasks.length;
      const initialEvents = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, conversionTask.id);

      checklistRepository.__testFaultHook = (stage) => {
        if (stage === "reindex") {
          throw new Error("Simulated fault at position reindex");
        }
      };

      await assert.rejects(async () => {
        await checklistRepository.convertToTask(LOCAL_WORKSPACE_ID, conversionTask.id, item1.id);
      }, /Simulated fault at position reindex/);

      checklistRepository.__testFaultHook = undefined;

      const tasksAfter = await taskRepository.list(LOCAL_WORKSPACE_ID, projectId);
      assert.equal(tasksAfter.length, initialTaskCount);

      const itemsAfter = await checklistRepository.list(LOCAL_WORKSPACE_ID, conversionTask.id);
      assert.equal(itemsAfter.length, 2);
      assert.equal(itemsAfter[0]?.id, item1.id);
      assert.equal(itemsAfter[0]?.position, 0);
      assert.equal(itemsAfter[1]?.id, item2.id);
      assert.equal(itemsAfter[1]?.position, 1);

      const eventsAfter = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, conversionTask.id);
      assert.equal(eventsAfter.length, initialEvents.length);
    });

    it("rolls back completely on fault during activity insertion", async () => {
      const conversionTask = await taskRepository.create(LOCAL_WORKSPACE_ID, {
        projectId,
        title: "Task with items for activity fault",
      });
      const item1 = await checklistRepository.create(LOCAL_WORKSPACE_ID, conversionTask.id, { text: "Activity item 1" });

      const initialTasks = await taskRepository.list(LOCAL_WORKSPACE_ID, projectId);
      const initialTaskCount = initialTasks.length;
      const initialEvents = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, conversionTask.id);

      checklistRepository.__testFaultHook = (stage) => {
        if (stage === "activity") {
          throw new Error("Simulated fault at activity insertion");
        }
      };

      await assert.rejects(async () => {
        await checklistRepository.convertToTask(LOCAL_WORKSPACE_ID, conversionTask.id, item1.id);
      }, /Simulated fault at activity insertion/);

      checklistRepository.__testFaultHook = undefined;

      const tasksAfter = await taskRepository.list(LOCAL_WORKSPACE_ID, projectId);
      assert.equal(tasksAfter.length, initialTaskCount);

      const itemsAfter = await checklistRepository.list(LOCAL_WORKSPACE_ID, conversionTask.id);
      assert.equal(itemsAfter.length, 1);
      assert.equal(itemsAfter[0]?.id, item1.id);

      const eventsAfter = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, conversionTask.id);
      assert.equal(eventsAfter.length, initialEvents.length);
    });
  });

  it("maintains null actor attribution on desktop SQLite for checklist operations and suppresses no-op events", async () => {
    const chkTask = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Checklist Attribution Task",
    });

    const item = await checklistRepository.create(
      LOCAL_WORKSPACE_ID,
      chkTask.id,
      { text: "Desktop checklist item" },
      { actorUserId: "mock-desktop-actor" },
    );

    const initialEvents = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, chkTask.id);
    const addedEvent = initialEvents.find(
      (e) => e.type === "checklist.item_added" && (e.details as any).itemId === item.id,
    );
    assert.ok(addedEvent);
    assert.equal(addedEvent.actorId, null, "Desktop SQLite must record null actorId on item_added");

    // Complete transition
    await checklistRepository.complete(
      LOCAL_WORKSPACE_ID,
      chkTask.id,
      item.id,
      { actorUserId: "mock-desktop-actor" },
    );
    const eventsAfterComp1 = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, chkTask.id);
    const compEvents1 = eventsAfterComp1.filter(
      (e) => e.type === "checklist.item_completed" && (e.details as any).itemId === item.id,
    );
    assert.equal(compEvents1.length, 1);
    assert.equal(compEvents1[0]?.actorId, null, "Desktop SQLite must record null actorId on item_completed");

    // Repeated complete (no-op)
    await checklistRepository.complete(
      LOCAL_WORKSPACE_ID,
      chkTask.id,
      item.id,
      { actorUserId: "mock-desktop-actor" },
    );
    const eventsAfterComp2 = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, chkTask.id);
    const compEvents2 = eventsAfterComp2.filter(
      (e) => e.type === "checklist.item_completed" && (e.details as any).itemId === item.id,
    );
    assert.equal(compEvents2.length, 1, "Idempotent completion must not emit extra events on desktop SQLite");

    // Reopen transition
    await checklistRepository.reopen(
      LOCAL_WORKSPACE_ID,
      chkTask.id,
      item.id,
      { actorUserId: "mock-desktop-actor" },
    );
    const eventsAfterReopen1 = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, chkTask.id);
    const reopenEvents1 = eventsAfterReopen1.filter(
      (e) => e.type === "checklist.item_reopened" && (e.details as any).itemId === item.id,
    );
    assert.equal(reopenEvents1.length, 1);
    assert.equal(reopenEvents1[0]?.actorId, null, "Desktop SQLite must record null actorId on item_reopened");

    // Repeated reopen (no-op)
    await checklistRepository.reopen(
      LOCAL_WORKSPACE_ID,
      chkTask.id,
      item.id,
      { actorUserId: "mock-desktop-actor" },
    );
    const eventsAfterReopen2 = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, chkTask.id);
    const reopenEvents2 = eventsAfterReopen2.filter(
      (e) => e.type === "checklist.item_reopened" && (e.details as any).itemId === item.id,
    );
    assert.equal(reopenEvents2.length, 1, "Idempotent reopen must not emit extra events on desktop SQLite");

    // Delete item
    await checklistRepository.delete(
      LOCAL_WORKSPACE_ID,
      chkTask.id,
      item.id,
      { actorUserId: "mock-desktop-actor" },
    );
    const eventsAfterDelete = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, chkTask.id);
    const deleteEvents = eventsAfterDelete.filter(
      (e) => e.type === "checklist.item_deleted" && (e.details as any).itemId === item.id,
    );
    assert.equal(deleteEvents.length, 1);
    assert.equal(deleteEvents[0]?.actorId, null, "Desktop SQLite must record null actorId on item_deleted");
  });
});

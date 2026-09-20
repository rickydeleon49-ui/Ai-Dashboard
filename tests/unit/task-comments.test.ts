/**
 * Task comments and activity history against a throwaway SQLite database — desktop mode.
 *
 * Verifies:
 * 1. Comment CRUD & edit history on SQLite.
 * 2. Soft-deletion preserving history on SQLite.
 * 3. Rejection of mentions on desktop mode (single-user, no workspace members).
 * 4. Activity events logged on desktop SQLite.
 * 5. Stored-XSS: raw payload stored verbatim, escaped on output.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db";
import { LOCAL_WORKSPACE_ID } from "../../src/db/repositories/project-repository";

let projectRepository: import("../../src/db/repositories/project-repository").ProjectRepository;
let taskRepository: import("../../src/db/repositories/task-repository").TaskRepository;
let commentRepository: import("../../src/db/repositories/comment-repository").CommentRepository;
let activityRepository: import("../../src/db/repositories/activity-repository").ActivityRepository;

let InvalidMentionError: typeof import("../../src/core/tasks/errors").InvalidMentionError;
let InvalidCommentError: typeof import("../../src/core/tasks/errors").InvalidCommentError;
let escapeHtml: typeof import("../../src/core/tasks/mention-utils").escapeHtml;

let projectId: string;
let taskId: string;

before(async () => {
  await migrate();
  ({ projectRepository, taskRepository, commentRepository, activityRepository } = await import(
    "../../src/db/repositories"
  ));
  ({ InvalidMentionError, InvalidCommentError } = await import("../../src/core/tasks/errors"));
  ({ escapeHtml } = await import("../../src/core/tasks/mention-utils"));

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

  it("lists comments in chronological order", async () => {
    const comment2 = await commentRepository.create(LOCAL_WORKSPACE_ID, taskId, {
      body: "Second desktop comment",
    });

    const list = await commentRepository.list(LOCAL_WORKSPACE_ID, taskId);
    assert.equal(list.length, 2);
    assert.equal(list[0]?.id, createdCommentId);
    assert.equal(list[1]?.id, comment2.id);
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

  it("soft-deletes a comment preserving audit history", async () => {
    const deleted = await commentRepository.delete(LOCAL_WORKSPACE_ID, taskId, createdCommentId);
    assert.equal(deleted, true);

    const fetched = await commentRepository.findById(LOCAL_WORKSPACE_ID, taskId, createdCommentId);
    assert.ok(fetched);
    assert.equal(fetched.isDeleted, true);
    assert.equal(fetched.body, "[This comment was deleted]");
    assert.equal(fetched.authorId, null);
    assert.ok(fetched.deletedAt);

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

  it("records activity events for task updates on SQLite", async () => {
    await taskRepository.update(LOCAL_WORKSPACE_ID, taskId, {
      status: "in_progress",
      priority: "high",
    });

    const events = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, taskId);
    const statusEvent = events.find((e) => e.type === "task.status_changed");
    assert.ok(statusEvent);
    assert.equal(statusEvent.details.from, "todo");
    assert.equal(statusEvent.details.to, "in_progress");

    const priorityEvent = events.find((e) => e.type === "task.priority_changed");
    assert.ok(priorityEvent);
    assert.equal(priorityEvent.details.from, "medium");
    assert.equal(priorityEvent.details.to, "high");
  });

  it("stores raw payload for stored-XSS and escapes output", async () => {
    const xss = "<script>alert('desktop-xss')</script>";
    const comment = await commentRepository.create(LOCAL_WORKSPACE_ID, taskId, {
      body: xss,
    });

    assert.equal(comment.body, xss);
    const escaped = escapeHtml(comment.body);
    assert.ok(!escaped.includes("<script>"));
    assert.ok(escaped.includes("&lt;script&gt;"));
  });
});

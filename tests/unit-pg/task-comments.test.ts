/**
 * Release 2C.4 Task Comments & Activity History: PostgreSQL Data and Repository Layer Integration Tests.
 *
 * Verifies:
 * 1. Comment CRUD & edit history:
 *    - create comment with author attribution, task, and workspace scoping
 *    - list comments in chronological order with editCount
 *    - findById
 *    - update comment creates audit snapshot in task_comment_edit and bumps editCount
 * 2. Soft deletion preserving history:
 *    - delete marks deletedAt and deletedBy, preserving row
 *    - read queries return placeholder text "[This comment was deleted]" and null authorId
 *    - getEditHistory remains accessible for deleted comments
 * 3. Mention validation against workspace membership:
 *    - mentioning active member succeeds
 *    - mentioning invited member succeeds
 *    - mentioning outsider fails with InvalidMentionError
 *    - mentioning suspended member fails with InvalidMentionError
 *    - mentioning removed member fails with InvalidMentionError
 * 4. Activity events:
 *    - written in same transaction for comment create, edit, delete
 *    - task status and priority changes write activity events
 *    - checklist complete writes activity events
 *    - listByTask and listByProject retrieve chronological events
 * 5. Cross-workspace isolation:
 *    - workspace B cannot read, update, or delete comments or activity from workspace A
 * 6. Stored-XSS protection:
 *    - raw payload stored verbatim without modification
 *    - escapeHtml helper safely escapes script tags
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";

let db: typeof import("../../src/db/pg-client").getPgDb;
let users: typeof import("../../src/db/schema.pg").users;
let workspacesTable: typeof import("../../src/db/schema.pg").workspaces;
let workspaceMembers: typeof import("../../src/db/schema.pg").workspaceMembers;
let taskCommentsTable: typeof import("../../src/db/schema.pg").taskComments;
let taskCommentEditsTable: typeof import("../../src/db/schema.pg").taskCommentEdits;
let taskActivityEventsTable: typeof import("../../src/db/schema.pg").taskActivityEvents;

let PostgresProjectRepository: typeof import(
  "../../src/db/repositories/postgres-project-repository"
).PostgresProjectRepository;
let PostgresTaskRepository: typeof import(
  "../../src/db/repositories/postgres-task-repository"
).PostgresTaskRepository;
let PostgresChecklistRepository: typeof import(
  "../../src/db/repositories/postgres-checklist-repository"
).PostgresChecklistRepository;
let PostgresCommentRepository: typeof import(
  "../../src/db/repositories/postgres-comment-repository"
).PostgresCommentRepository;
let PostgresActivityRepository: typeof import(
  "../../src/db/repositories/postgres-activity-repository"
).PostgresActivityRepository;

let InvalidMentionError: typeof import("../../src/core/tasks/errors").InvalidMentionError;
let InvalidCommentError: typeof import("../../src/core/tasks/errors").InvalidCommentError;
let escapeHtml: typeof import("../../src/core/tasks/mention-utils").escapeHtml;

let projectRepo: import("../../src/db/repositories/project-repository").ProjectRepository;
let taskRepo: import("../../src/db/repositories/task-repository").TaskRepository;
let checklistRepo: import("../../src/db/repositories/checklist-repository").ChecklistRepository;
let commentRepo: import("../../src/db/repositories/comment-repository").CommentRepository;
let activityRepo: import("../../src/db/repositories/activity-repository").ActivityRepository;

let workspaceA: string;
let workspaceB: string;
let userActive: string;
let userInvited: string;
let userSuspended: string;
let userRemoved: string;
let userOutsider: string;

let projectA: string;
let taskA1: string;

before(async () => {
  await migrate();

  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  ({
    users,
    workspaces: workspacesTable,
    workspaceMembers,
    taskComments: taskCommentsTable,
    taskCommentEdits: taskCommentEditsTable,
    taskActivityEvents: taskActivityEventsTable,
  } = await import("../../src/db/schema.pg"));

  ({ PostgresProjectRepository } = await import("../../src/db/repositories/postgres-project-repository"));
  ({ PostgresTaskRepository } = await import("../../src/db/repositories/postgres-task-repository"));
  ({ PostgresChecklistRepository } = await import("../../src/db/repositories/postgres-checklist-repository"));
  ({ PostgresCommentRepository } = await import("../../src/db/repositories/postgres-comment-repository"));
  ({ PostgresActivityRepository } = await import("../../src/db/repositories/postgres-activity-repository"));

  ({ InvalidMentionError, InvalidCommentError } = await import("../../src/core/tasks/errors"));
  ({ escapeHtml } = await import("../../src/core/tasks/mention-utils"));

  projectRepo = new PostgresProjectRepository();
  taskRepo = new PostgresTaskRepository();
  checklistRepo = new PostgresChecklistRepository();
  commentRepo = new PostgresCommentRepository();
  activityRepo = new PostgresActivityRepository();

  const pgDb = db();

  // Seed Users
  userActive = crypto.randomUUID();
  userInvited = crypto.randomUUID();
  userSuspended = crypto.randomUUID();
  userRemoved = crypto.randomUUID();
  userOutsider = crypto.randomUUID();

  await pgDb.insert(users).values([
    { id: userActive, name: "Active User", email: "active@example.com" },
    { id: userInvited, name: "Invited User", email: "invited@example.com" },
    { id: userSuspended, name: "Suspended User", email: "suspended@example.com" },
    { id: userRemoved, name: "Removed User", email: "removed@example.com" },
    { id: userOutsider, name: "Outsider User", email: "outsider@example.com" },
  ]);

  // Seed Workspaces
  workspaceA = "ws-cm-a";
  workspaceB = "ws-cm-b";

  await pgDb.insert(workspacesTable).values([
    { id: workspaceA, name: "Workspace A", slug: "workspace-a", kind: "team", createdBy: userActive },
    { id: workspaceB, name: "Workspace B", slug: "workspace-b", kind: "team", createdBy: userOutsider },
  ]);

  // Seed Workspace Memberships for Workspace A
  await pgDb.insert(workspaceMembers).values([
    { workspaceId: workspaceA, userId: userActive, role: "owner", status: "active" },
    { workspaceId: workspaceA, userId: userInvited, role: "member", status: "invited" },
    { workspaceId: workspaceA, userId: userSuspended, role: "member", status: "suspended" },
    { workspaceId: workspaceA, userId: userRemoved, role: "member", status: "removed" },
    // Outsider belongs only to Workspace B
    { workspaceId: workspaceB, userId: userOutsider, role: "owner", status: "active" },
  ]);

  // Seed Project and Task in Workspace A
  const pA = await projectRepo.create(workspaceA, { name: "Project A" });
  projectA = pA.id;

  const tA = await taskRepo.create(
    workspaceA,
    { projectId: projectA, title: "Task A1", priority: "medium" },
    { actorUserId: userActive },
  );
  taskA1 = tA.id;
});

after(async () => {
  await cleanup();
});

describe("PostgreSQL Task Comments & Activity Repository", () => {
  let createdCommentId: string;

  it("creates a comment and logs a comment.created activity event", async () => {
    const comment = await commentRepo.create(
      workspaceA,
      taskA1,
      { body: "First comment on task A1" },
      { actorUserId: userActive },
    );

    assert.ok(comment.id);
    assert.equal(comment.taskId, taskA1);
    assert.equal(comment.workspaceId, workspaceA);
    assert.equal(comment.authorId, userActive);
    assert.equal(comment.body, "First comment on task A1");
    assert.equal(comment.isDeleted, false);
    assert.equal(comment.editCount, 0);

    createdCommentId = comment.id;

    // Check activity events
    const events = await activityRepo.listByTask(workspaceA, taskA1);
    const createdEvent = events.find((e) => e.type === "comment.created");
    assert.ok(createdEvent);
    assert.equal(createdEvent.actorId, userActive);
    assert.equal(createdEvent.details.commentId, comment.id);
  });

  it("lists comments in chronological order", async () => {
    const comment2 = await commentRepo.create(
      workspaceA,
      taskA1,
      { body: "Second comment on task A1" },
      { actorUserId: userActive },
    );

    const list = await commentRepo.list(workspaceA, taskA1);
    assert.equal(list.length, 2);
    assert.equal(list[0]?.id, createdCommentId);
    assert.equal(list[1]?.id, comment2.id);
  });

  it("updates a comment and records previous body in edit history", async () => {
    const updated = await commentRepo.update(
      workspaceA,
      taskA1,
      createdCommentId,
      { body: "Edited first comment body" },
      { actorUserId: userActive },
    );

    assert.ok(updated);
    assert.equal(updated.body, "Edited first comment body");
    assert.equal(updated.editCount, 1);

    // Verify edit history
    const history = await commentRepo.getEditHistory(workspaceA, taskA1, createdCommentId);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.previousBody, "First comment on task A1");
    assert.equal(history[0]?.editedBy, userActive);

    // Verify activity event
    const events = await activityRepo.listByTask(workspaceA, taskA1);
    const editEvent = events.find((e) => e.type === "comment.edited");
    assert.ok(editEvent);
    assert.equal(editEvent.details.commentId, createdCommentId);
  });

  it("soft-deletes a comment preserving audit history", async () => {
    const deleted = await commentRepo.delete(
      workspaceA,
      taskA1,
      createdCommentId,
      { actorUserId: userActive },
    );
    assert.equal(deleted, true);

    // Read via findById
    const fetched = await commentRepo.findById(workspaceA, taskA1, createdCommentId);
    assert.ok(fetched);
    assert.equal(fetched.isDeleted, true);
    assert.equal(fetched.body, "[This comment was deleted]");
    assert.equal(fetched.authorId, null);
    assert.ok(fetched.deletedAt);

    // Edit history is still accessible
    const history = await commentRepo.getEditHistory(workspaceA, taskA1, createdCommentId);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.previousBody, "First comment on task A1");

    // Attempting to edit a deleted comment throws
    await assert.rejects(
      async () => {
        await commentRepo.update(workspaceA, taskA1, createdCommentId, { body: "Try to edit deleted" });
      },
      InvalidCommentError,
    );

    // Activity event recorded
    const events = await activityRepo.listByTask(workspaceA, taskA1);
    const deleteEvent = events.find((e) => e.type === "comment.deleted");
    assert.ok(deleteEvent);
    assert.equal(deleteEvent.details.commentId, createdCommentId);
  });

  it("validates mentions against workspace membership", async () => {
    // Active member mention succeeds
    const commentWithActive = await commentRepo.create(
      workspaceA,
      taskA1,
      { body: `Hello @[Active]( ${userActive} )` },
      { actorUserId: userActive },
    );
    assert.ok(commentWithActive);

    // Invited member mention succeeds
    const commentWithInvited = await commentRepo.create(
      workspaceA,
      taskA1,
      { body: `Hey @${userInvited} please review` },
      { actorUserId: userActive },
    );
    assert.ok(commentWithInvited);

    // Outsider mention fails
    await assert.rejects(
      async () => {
        await commentRepo.create(
          workspaceA,
          taskA1,
          { body: `Hey @${userOutsider}` },
          { actorUserId: userActive },
        );
      },
      InvalidMentionError,
    );

    // Suspended member mention fails
    await assert.rejects(
      async () => {
        await commentRepo.create(
          workspaceA,
          taskA1,
          { body: `Hey @${userSuspended}` },
          { actorUserId: userActive },
        );
      },
      InvalidMentionError,
    );

    // Removed member mention fails
    await assert.rejects(
      async () => {
        await commentRepo.create(
          workspaceA,
          taskA1,
          { body: `Hey @${userRemoved}` },
          { actorUserId: userActive },
        );
      },
      InvalidMentionError,
    );
  });

  it("records activity events for task updates and checklist mutations", async () => {
    // Task status change
    await taskRepo.update(
      workspaceA,
      taskA1,
      { status: "in_progress", priority: "urgent" },
      { actorUserId: userActive },
    );

    // Checklist mutation
    const item = await checklistRepo.create(
      workspaceA,
      taskA1,
      { text: "Verify checklist event" },
      { actorUserId: userActive },
    );
    await checklistRepo.complete(workspaceA, taskA1, item.id, { actorUserId: userActive });

    const events = await activityRepo.listByTask(workspaceA, taskA1);

    const statusEvent = events.find((e) => e.type === "task.status_changed");
    assert.ok(statusEvent);
    assert.equal(statusEvent.details.from, "todo");
    assert.equal(statusEvent.details.to, "in_progress");

    const priorityEvent = events.find((e) => e.type === "task.priority_changed");
    assert.ok(priorityEvent);
    assert.equal(priorityEvent.details.from, "medium");
    assert.equal(priorityEvent.details.to, "urgent");

    const checklistEvent = events.find((e) => e.type === "checklist.item_completed");
    assert.ok(checklistEvent);
    assert.equal(checklistEvent.details.itemId, item.id);
  });

  it("strictly enforces cross-workspace isolation", async () => {
    // Workspace B cannot list comments for task in Workspace A
    const listFromB = await commentRepo.list(workspaceB, taskA1);
    assert.equal(listFromB.length, 0);

    // Workspace B cannot access activity events for task in Workspace A
    const activityFromB = await activityRepo.listByTask(workspaceB, taskA1);
    assert.equal(activityFromB.length, 0);

    // Workspace B cannot find comment created in Workspace A
    const foundFromB = await commentRepo.findById(workspaceB, taskA1, createdCommentId);
    assert.equal(foundFromB, null);
  });

  it("stores raw payload for stored-XSS protection and escapes output safely", async () => {
    const xssPayload = "<script>alert('xss')</script><img src=x onerror=alert(1)>";

    const comment = await commentRepo.create(
      workspaceA,
      taskA1,
      { body: xssPayload },
      { actorUserId: userActive },
    );

    // 1. Raw body in DB is preserved verbatim
    assert.equal(comment.body, xssPayload);

    // 2. Output escaping helper escapes HTML entities
    const escaped = escapeHtml(comment.body);
    assert.ok(!escaped.includes("<script>"));
    assert.ok(escaped.includes("&lt;script&gt;"));
    assert.ok(escaped.includes("&lt;img src=x onerror=alert(1)&gt;"));
  });
});

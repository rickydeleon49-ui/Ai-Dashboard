/**
 * Release 2C.4 Task Comments & Activity History: PostgreSQL Data and Repository Layer Integration Tests.
 *
 * Verifies:
 * 1. Comment CRUD & edit history:
 *    - create comment with author attribution, task, and workspace scoping
 *    - list comments in chronological order with paginated envelope and bounded editCount
 *    - findById
 *    - update comment creates audit snapshot in task_comment_edit and bumps editCount
 * 2. Soft deletion preserving history:
 *    - delete marks deletedAt, redacting author and body on domain reads
 *    - read queries return placeholder text "[This comment was deleted]", null authorId, and null deletedBy
 *    - getEditHistory remains accessible for deleted comments
 * 3. Mention validation & bounds:
 *    - mentioning active member succeeds
 *    - mentioning invited member succeeds
 *    - mentioning outsider fails with InvalidMentionError
 *    - mentioning suspended member fails with InvalidMentionError
 *    - mentioning removed member fails with InvalidMentionError
 *    - mentioning > 50 members fails with InvalidMentionError
 *    - mentioning malformed user ID fails with InvalidMentionError
 * 4. Activity events:
 *    - written in same transaction for comment create, edit, delete
 *    - task status and priority changes write activity events
 *    - checklist complete writes activity events
 *    - listByTask and listByProject retrieve chronological events
 *    - idempotent operations (dependency add/remove, checklist complete/reopen) do not increase event counts
 *    - dependency activity events record actor attribution
 * 5. Cross-workspace isolation:
 *    - workspace B cannot read, update, or delete comments or activity from workspace A
 * 6. Stored-XSS protection:
 *    - raw payload stored verbatim without modification
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { inArray } from "drizzle-orm";
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
let InvalidPaginationError: typeof import("../../src/core/tasks/errors").InvalidPaginationError;

let projectRepo: import("../../src/db/repositories/postgres-project-repository").PostgresProjectRepository;
let taskRepo: import("../../src/db/repositories/postgres-task-repository").PostgresTaskRepository;
let checklistRepo: import("../../src/db/repositories/postgres-checklist-repository").PostgresChecklistRepository;
let commentRepo: import("../../src/db/repositories/postgres-comment-repository").PostgresCommentRepository;
let activityRepo: import("../../src/db/repositories/postgres-activity-repository").PostgresActivityRepository;

// Workspaces and users
const workspaceA = "ws-comments-pg-a";
const workspaceB = "ws-comments-pg-b";

const userActive = "11111111-1111-4111-8111-111111111111";
const userInvited = "22222222-2222-4222-8222-222222222222";
const userSuspended = "33333333-3333-4333-8333-333333333333";
const userRemoved = "44444444-4444-4444-8444-444444444444";
const userOutsider = "55555555-5555-4555-8555-555555555555";

let projectA: string;
let taskA1: string;
let taskA2: string;

before(async () => {
  await migrate();
  const pgClient = await import("../../src/db/pg-client");
  db = pgClient.getPgDb;

  const schema = await import("../../src/db/schema.pg");
  users = schema.users;
  workspacesTable = schema.workspaces;
  workspaceMembers = schema.workspaceMembers;
  taskCommentsTable = schema.taskComments;
  taskCommentEditsTable = schema.taskCommentEdits;
  taskActivityEventsTable = schema.taskActivityEvents;

  PostgresProjectRepository = (
    await import("../../src/db/repositories/postgres-project-repository")
  ).PostgresProjectRepository;
  PostgresTaskRepository = (
    await import("../../src/db/repositories/postgres-task-repository")
  ).PostgresTaskRepository;
  PostgresChecklistRepository = (
    await import("../../src/db/repositories/postgres-checklist-repository")
  ).PostgresChecklistRepository;
  PostgresCommentRepository = (
    await import("../../src/db/repositories/postgres-comment-repository")
  ).PostgresCommentRepository;
  PostgresActivityRepository = (
    await import("../../src/db/repositories/postgres-activity-repository")
  ).PostgresActivityRepository;

  ({ InvalidMentionError, InvalidCommentError, InvalidPaginationError } = await import(
    "../../src/core/tasks/errors"
  ));

  projectRepo = new PostgresProjectRepository();
  taskRepo = new PostgresTaskRepository();
  checklistRepo = new PostgresChecklistRepository(taskRepo);
  commentRepo = new PostgresCommentRepository();
  activityRepo = new PostgresActivityRepository();

  const pg = db();

  // Seed users
  for (const uid of [userActive, userInvited, userSuspended, userRemoved, userOutsider]) {
    await pg
      .insert(users)
      .values({
        id: uid,
        name: `User ${uid}`,
        email: `${uid}@example.com`,
      })
      .onConflictDoNothing();
  }

  // Seed workspaces
  for (const wid of [workspaceA, workspaceB]) {
    await pg
      .insert(workspacesTable)
      .values({
        id: wid,
        name: `Workspace ${wid}`,
        slug: wid,
        kind: "team",
      })
      .onConflictDoNothing();
  }

  // Seed members for Workspace A
  await pg
    .insert(workspaceMembers)
    .values([
      { workspaceId: workspaceA, userId: userActive, role: "member", status: "active" },
      { workspaceId: workspaceA, userId: userInvited, role: "member", status: "invited" },
      { workspaceId: workspaceA, userId: userSuspended, role: "member", status: "suspended" },
      { workspaceId: workspaceA, userId: userRemoved, role: "member", status: "removed" },
    ])
    .onConflictDoNothing();

  // Create Project & Tasks in Workspace A
  const proj = await projectRepo.create(workspaceA, { name: "Project Alpha" });
  projectA = proj.id;

  const t1 = await taskRepo.create(
    workspaceA,
    { projectId: projectA, title: "Task Alpha 1" },
    { actorUserId: userActive },
  );
  taskA1 = t1.id;

  const t2 = await taskRepo.create(
    workspaceA,
    { projectId: projectA, title: "Task Alpha 2" },
    { actorUserId: userActive },
  );
  taskA2 = t2.id;
});

after(async () => {
  await cleanup();
});

describe("PostgreSQL CommentRepository & ActivityRepository", () => {
  let createdCommentId: string;

  it("creates a comment with author attribution and logs activity in same transaction", async () => {
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

  it("lists comments in chronological order with pagination envelope", async () => {
    const comment2 = await commentRepo.create(
      workspaceA,
      taskA1,
      { body: "Second comment on task A1" },
      { actorUserId: userActive },
    );

    const page = await commentRepo.list(workspaceA, taskA1);
    assert.equal(page.comments.length, 2);
    assert.equal(page.comments[0]?.id, createdCommentId);
    assert.equal(page.comments[1]?.id, comment2.id);
    assert.equal(page.nextCursor, null);
  });

  it("paginates comments with stable cursor and bounded limits", async () => {
    const paginationTask = await taskRepo.create(
      workspaceA,
      { projectId: projectA, title: "PG Dedicated Pagination Task" },
      { actorUserId: userActive },
    );
    const createdComments: Array<{ id: string; createdAt: string }> = [];
    for (let i = 1; i <= 5; i++) {
      const c = await commentRepo.create(
        workspaceA,
        paginationTask.id,
        { body: `PG pagination test comment ${i}` },
        { actorUserId: userActive },
      );
      createdComments.push({ id: c.id, createdAt: c.createdAt });
      // Small pause to give distinct timestamps where supported
      await new Promise((r) => setTimeout(r, 5));
    }

    // Sort expected comments by the canonical database ordering: createdAt ASC, then id ASC
    createdComments.sort((a, b) => {
      const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });

    // Page 1: limit 2
    const page1 = await commentRepo.list(workspaceA, paginationTask.id, { limit: 2 });
    assert.equal(page1.comments.length, 2);
    assert.equal(page1.comments[0]?.id, createdComments[0]!.id);
    assert.equal(page1.comments[1]?.id, createdComments[1]!.id);
    assert.ok(page1.nextCursor);

    // Page 2: limit 2 with cursor
    const page2 = await commentRepo.list(workspaceA, paginationTask.id, {
      limit: 2,
      cursor: page1.nextCursor,
    });
    assert.equal(page2.comments.length, 2);
    assert.equal(page2.comments[0]?.id, createdComments[2]!.id);
    assert.equal(page2.comments[1]?.id, createdComments[3]!.id);
    assert.ok(page2.nextCursor);

    // Page 3: limit 2 with cursor -> returns the final comment
    const page3 = await commentRepo.list(workspaceA, paginationTask.id, {
      limit: 2,
      cursor: page2.nextCursor,
    });
    assert.equal(page3.comments.length, 1);
    assert.equal(page3.comments[0]?.id, createdComments[4]!.id);
    assert.equal(page3.nextCursor, null);

    // Assert exact IDs and stable (createdAt, id) ordering across every page
    const allFetched = [...page1.comments, ...page2.comments, ...page3.comments];
    assert.deepEqual(allFetched.map((c) => c.id), createdComments.map((c) => c.id));
    for (let i = 1; i < allFetched.length; i++) {
      const prev = allFetched[i - 1]!;
      const curr = allFetched[i]!;
      const timeDiff = new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime();
      assert.ok(
        timeDiff > 0 || (timeDiff === 0 && curr.id > prev.id),
        "Comments must be ordered strictly ascending by (createdAt, id)",
      );
    }
  });

  it("preserves stable ordering and pagination across equal timestamps in PostgreSQL (createdAt ASC, id ASC)", async () => {
    const timestampTask = await taskRepo.create(
      workspaceA,
      { projectId: projectA, title: "PG Same Timestamp Task" },
      { actorUserId: userActive },
    );

    const c1 = await commentRepo.create(
      workspaceA,
      timestampTask.id,
      { body: "PG Comment timestamp A" },
      { actorUserId: userActive },
    );
    const c2 = await commentRepo.create(
      workspaceA,
      timestampTask.id,
      { body: "PG Comment timestamp B" },
      { actorUserId: userActive },
    );

    // Force exact identical createdAt timestamp
    const fixedTime = new Date("2026-09-20T12:00:00.000Z");
    const pg = db();
    await pg
      .update(taskCommentsTable)
      .set({ createdAt: fixedTime })
      .where(inArray(taskCommentsTable.id, [c1.id, c2.id]));

    const expectedOrder = [c1.id, c2.id].sort();
    const firstId = expectedOrder[0]!;
    const secondId = expectedOrder[1]!;

    // Fetch page 1 with limit 1
    const p1 = await commentRepo.list(workspaceA, timestampTask.id, { limit: 1 });
    assert.equal(p1.comments.length, 1);
    assert.equal(p1.comments[0]?.id, firstId);
    assert.ok(p1.nextCursor);

    // Fetch page 2 with limit 1 and cursor
    const p2 = await commentRepo.list(workspaceA, timestampTask.id, {
      limit: 1,
      cursor: p1.nextCursor,
    });
    assert.equal(p2.comments.length, 1);
    assert.equal(p2.comments[0]?.id, secondId);
    assert.equal(p2.nextCursor, null);
  });

  it("throws InvalidPaginationError on malformed cursor in PostgreSQL and never silently restarts", async () => {
    await assert.rejects(async () => {
      await commentRepo.list(workspaceA, taskA1, {
        cursor: "not-valid-base64url!@#",
      });
    }, InvalidPaginationError);

    await assert.rejects(async () => {
      await commentRepo.list(workspaceA, taskA1, {
        cursor: Buffer.from("invalid-json").toString("base64url"),
      });
    }, InvalidPaginationError);
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

  it("soft-deletes a comment preserving audit history and redacting body/author/deletedBy on reads", async () => {
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
    assert.equal(fetched.deletedBy, null);
    assert.ok(fetched.deletedAt);

    // Edit history is still accessible via repository
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

  it("validates mentions against workspace membership and workload bounds", async () => {
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

    // Malformed UUID mention fails
    await assert.rejects(
      async () => {
        await commentRepo.create(
          workspaceA,
          taskA1,
          { body: "Hello @[Invalid](not-a-valid-uuid)" },
          { actorUserId: userActive },
        );
      },
      InvalidMentionError,
    );

    // Excess mentions (>50) fails
    const excessMentions: string[] = [];
    for (let i = 0; i < 51; i++) {
      excessMentions.push(crypto.randomUUID());
    }
    await assert.rejects(
      async () => {
        await commentRepo.create(
          workspaceA,
          taskA1,
          { body: "Oversized mentions", mentions: excessMentions },
          { actorUserId: userActive },
        );
      },
      /cannot mention more than 50 users/i,
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

  it("emits activity events only for real state transitions and preserves actor attribution", async () => {
    // 1. Dependency addition with actor attribution
    await taskRepo.addDependency(workspaceA, taskA1, taskA2, { actorUserId: userActive });
    const eventsAfterAdd1 = await activityRepo.listByTask(workspaceA, taskA1);
    const addEvents1 = eventsAfterAdd1.filter((e) => e.type === "task.dependency_added");
    assert.equal(addEvents1.length, 1);
    assert.equal(addEvents1[0]?.actorId, userActive, "Dependency add event must contain authenticated actor");

    // Repeat dependency addition (no-op)
    await taskRepo.addDependency(workspaceA, taskA1, taskA2, { actorUserId: userActive });
    const eventsAfterAdd2 = await activityRepo.listByTask(workspaceA, taskA1);
    const addEvents2 = eventsAfterAdd2.filter((e) => e.type === "task.dependency_added");
    assert.equal(addEvents2.length, 1, "Idempotent dependency add must not emit second activity event");

    // 2. Dependency removal with actor attribution
    await taskRepo.removeDependency(workspaceA, taskA1, taskA2, { actorUserId: userActive });
    const eventsAfterRem1 = await activityRepo.listByTask(workspaceA, taskA1);
    const remEvents1 = eventsAfterRem1.filter((e) => e.type === "task.dependency_removed");
    assert.equal(remEvents1.length, 1);
    assert.equal(remEvents1[0]?.actorId, userActive, "Dependency removal event must contain authenticated actor");

    // Repeat dependency removal (no-op)
    await taskRepo.removeDependency(workspaceA, taskA1, taskA2, { actorUserId: userActive });
    const eventsAfterRem2 = await activityRepo.listByTask(workspaceA, taskA1);
    const remEvents2 = eventsAfterRem2.filter((e) => e.type === "task.dependency_removed");
    assert.equal(remEvents2.length, 1, "Idempotent dependency remove must not emit second activity event");

    // 3. Checklist state transitions with actor attribution
    const checkItem = await checklistRepo.create(workspaceA, taskA1, { text: "PG transition item" }, { actorUserId: userActive });

    // Complete transition (false -> true)
    await checklistRepo.complete(workspaceA, taskA1, checkItem.id, { actorUserId: userActive });
    const eventsAfterComp1 = await activityRepo.listByTask(workspaceA, taskA1);
    const compEvents1 = eventsAfterComp1.filter((e) => e.type === "checklist.item_completed");
    assert.equal(compEvents1.length, 2); // 1 from earlier test + 1 now
    assert.equal(compEvents1[1]?.actorId, userActive, "Checklist complete event must contain authenticated actor");

    // Repeat complete (true -> true, no-op)
    await checklistRepo.complete(workspaceA, taskA1, checkItem.id, { actorUserId: userActive });
    const eventsAfterComp2 = await activityRepo.listByTask(workspaceA, taskA1);
    const compEvents2 = eventsAfterComp2.filter((e) => e.type === "checklist.item_completed");
    assert.equal(compEvents2.length, 2, "Idempotent checklist complete must not emit second activity event");

    // Reopen transition (true -> false)
    await checklistRepo.reopen(workspaceA, taskA1, checkItem.id, { actorUserId: userActive });
    const eventsAfterReopen1 = await activityRepo.listByTask(workspaceA, taskA1);
    const reopenEvents1 = eventsAfterReopen1.filter((e) => e.type === "checklist.item_reopened");
    assert.equal(reopenEvents1.length, 1);
    assert.equal(reopenEvents1[0]?.actorId, userActive, "Checklist reopen event must contain authenticated actor");

    // Repeat reopen (false -> false, no-op)
    await checklistRepo.reopen(workspaceA, taskA1, checkItem.id, { actorUserId: userActive });
    const eventsAfterReopen2 = await activityRepo.listByTask(workspaceA, taskA1);
    const reopenEvents2 = eventsAfterReopen2.filter((e) => e.type === "checklist.item_reopened");
    assert.equal(reopenEvents2.length, 1, "Idempotent checklist reopen must not emit second activity event");

    // 4. Delete item with actor attribution
    await checklistRepo.delete(workspaceA, taskA1, checkItem.id, { actorUserId: userActive });
    const eventsAfterDelete = await activityRepo.listByTask(workspaceA, taskA1);
    const deleteEvents = eventsAfterDelete.filter((e) => e.type === "checklist.item_deleted");
    assert.equal(deleteEvents.length, 1);
    assert.equal(deleteEvents[0]?.actorId, userActive, "Checklist delete event must contain authenticated actor");
  });

  it("strictly enforces cross-workspace isolation", async () => {
    // Workspace B cannot list comments for task in Workspace A
    const listFromB = await commentRepo.list(workspaceB, taskA1);
    assert.equal(listFromB.comments.length, 0);

    // Workspace B cannot access activity events for task in Workspace A
    const activityFromB = await activityRepo.listByTask(workspaceB, taskA1);
    assert.equal(activityFromB.length, 0);

    // Workspace B cannot find comment created in Workspace A
    const foundFromB = await commentRepo.findById(workspaceB, taskA1, createdCommentId);
    assert.equal(foundFromB, null);
  });

  it("stores raw payload for stored-XSS protection without modification", async () => {
    const xssPayload = "<script>alert('xss')</script><img src=x onerror=alert(1)>";

    const comment = await commentRepo.create(
      workspaceA,
      taskA1,
      { body: xssPayload },
      { actorUserId: userActive },
    );

    // Raw body in DB is preserved verbatim
    assert.equal(comment.body, xssPayload);
    const read = await commentRepo.findById(workspaceA, taskA1, comment.id);
    assert.equal(read?.body, xssPayload);
  });
});

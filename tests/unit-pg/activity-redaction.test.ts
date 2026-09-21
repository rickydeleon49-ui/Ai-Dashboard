/**
 * Deleted-comment redaction on normal activity listings (PostgreSQL).
 *
 * The comment endpoints already hide a deleted comment's author, deleter, and
 * body. These tests prove the activity listings don't leak the same facts
 * through comment.created / comment.edited / comment.deleted events, while the
 * stored rows stay untouched and live comments keep full attribution.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";
import {
  assertSafeDeletedCommentEvent,
  lifecycleEventsFor,
} from "../helpers/activity-redaction-expectations";

type ActivityRepoClass = typeof import("../../src/db/repositories/postgres-activity-repository").PostgresActivityRepository;

let PostgresActivityRepository: ActivityRepoClass;
let activityRepo: InstanceType<ActivityRepoClass>;
let commentRepo: import("../../src/db/repositories/postgres-comment-repository").PostgresCommentRepository;
let db: typeof import("../../src/db/pg-client").getPgDb;
let schema: typeof import("../../src/db/schema.pg");

const WS_A = "ws-redact-pg-a";
const WS_B = "ws-redact-pg-b";
const AUTHOR = "a1111111-1111-4111-8111-111111111111";
const DELETER = "a2222222-2222-4222-8222-222222222222";
const MENTION_1 = "a3333333-3333-4333-8333-333333333333";
const MENTION_2 = "a4444444-4444-4444-8444-444444444444";
const OUTSIDER = "a5555555-5555-4555-8555-555555555555";

let projectA: string;
let taskA1: string;
let taskA2: string;
let projectB: string;
let taskB1: string;
let deletedCommentId: string;
let liveCommentId: string;
let otherTaskLiveCommentId: string;

before(async () => {
  await migrate();
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  schema = await import("../../src/db/schema.pg");
  ({ PostgresActivityRepository } = await import("../../src/db/repositories/postgres-activity-repository"));
  const { PostgresCommentRepository } = await import("../../src/db/repositories/postgres-comment-repository");
  const { PostgresProjectRepository } = await import("../../src/db/repositories/postgres-project-repository");
  const { PostgresTaskRepository } = await import("../../src/db/repositories/postgres-task-repository");

  activityRepo = new PostgresActivityRepository();
  commentRepo = new PostgresCommentRepository();
  const projectRepo = new PostgresProjectRepository();
  const taskRepo = new PostgresTaskRepository();
  const pg = db();

  for (const id of [AUTHOR, DELETER, MENTION_1, MENTION_2, OUTSIDER]) {
    await pg.insert(schema.users).values({ id, name: `User ${id}`, email: `${id}@example.test` });
  }
  for (const id of [WS_A, WS_B]) {
    await pg.insert(schema.workspaces).values({ id, name: id, slug: id, kind: "team" });
  }
  await pg.insert(schema.workspaceMembers).values([
    { workspaceId: WS_A, userId: AUTHOR, role: "member", status: "active" },
    { workspaceId: WS_A, userId: DELETER, role: "admin", status: "active" },
    { workspaceId: WS_A, userId: MENTION_1, role: "member", status: "active" },
    { workspaceId: WS_A, userId: MENTION_2, role: "viewer", status: "active" },
    { workspaceId: WS_B, userId: OUTSIDER, role: "owner", status: "active" },
  ]);

  projectA = (await projectRepo.create(WS_A, { name: "Redaction A" })).id;
  taskA1 = (await taskRepo.create(WS_A, { projectId: projectA, title: "A1" }, { actorUserId: AUTHOR })).id;
  taskA2 = (await taskRepo.create(WS_A, { projectId: projectA, title: "A2" }, { actorUserId: AUTHOR })).id;
  projectB = (await projectRepo.create(WS_B, { name: "Redaction B" })).id;
  taskB1 = (await taskRepo.create(WS_B, { projectId: projectB, title: "B1" }, { actorUserId: OUTSIDER })).id;

  // A comment that is created with mentions, edited by its author, then deleted by an admin.
  const doomed = await commentRepo.create(
    WS_A,
    taskA1,
    { body: "secret plan", mentions: [MENTION_1, MENTION_2] },
    { actorUserId: AUTHOR },
  );
  deletedCommentId = doomed.id;
  await commentRepo.update(WS_A, taskA1, doomed.id, { body: "secret plan v2" }, { actorUserId: AUTHOR });
  await commentRepo.delete(WS_A, taskA1, doomed.id, { actorUserId: DELETER });

  // A live comment, with a duplicated mention that must come back deduplicated.
  const live = await commentRepo.create(
    WS_A,
    taskA1,
    { body: "still here", mentions: [MENTION_1, MENTION_1, MENTION_2] },
    { actorUserId: AUTHOR },
  );
  liveCommentId = live.id;

  otherTaskLiveCommentId = (
    await commentRepo.create(WS_A, taskA2, { body: "on A2" }, { actorUserId: AUTHOR })
  ).id;
});

after(() => cleanup());

const FORBIDDEN = [AUTHOR, DELETER, MENTION_1, MENTION_2];

describe("Deleted-comment redaction on activity listings (PostgreSQL)", () => {
  it("task activity hides the author, editor, deleter, and mentions of a deleted comment", async () => {
    const events = await activityRepo.listByTask(WS_A, taskA1);
    const lifecycle = lifecycleEventsFor(events, deletedCommentId);
    assert.deepEqual([...lifecycle.keys()].sort(), ["comment.created", "comment.deleted", "comment.edited"]);
    for (const event of lifecycle.values()) {
      assertSafeDeletedCommentEvent(event, deletedCommentId, FORBIDDEN);
    }
  });

  it("project activity applies the same redaction", async () => {
    const events = await activityRepo.listByProject(WS_A, projectA);
    const lifecycle = lifecycleEventsFor(events, deletedCommentId);
    assert.equal(lifecycle.size, 3);
    for (const event of lifecycle.values()) {
      assertSafeDeletedCommentEvent(event, deletedCommentId, FORBIDDEN);
    }
  });

  it("live comments keep actor attribution and deduplicated mentions", async () => {
    for (const events of [
      await activityRepo.listByTask(WS_A, taskA1),
      await activityRepo.listByProject(WS_A, projectA),
    ]) {
      const created = lifecycleEventsFor(events, liveCommentId).get("comment.created");
      assert.ok(created);
      assert.equal(created.actorId, AUTHOR);
      assert.deepEqual(created.details, { commentId: liveCommentId, mentions: [MENTION_1, MENTION_2] });
    }
  });

  it("leaves the stored activity rows unchanged", async () => {
    const { sql } = await import("drizzle-orm");
    const rows = await db()
      .select()
      .from(schema.taskActivityEvents)
      .where(sql`${schema.taskActivityEvents.details}->>'commentId' = ${deletedCommentId}`);
    const byType = new Map(rows.map((r) => [r.type, r]));
    assert.equal(byType.get("comment.created")?.actorId, AUTHOR);
    assert.deepEqual(byType.get("comment.created")?.details, {
      commentId: deletedCommentId,
      mentions: [MENTION_1, MENTION_2],
    });
    assert.equal(byType.get("comment.edited")?.actorId, AUTHOR);
    assert.equal(byType.get("comment.deleted")?.actorId, DELETER);
  });

  it("keeps workspace scoping: another workspace sees none of workspace A's activity", async () => {
    assert.deepEqual(await activityRepo.listByTask(WS_B, taskA1), []);
    assert.deepEqual(await activityRepo.listByProject(WS_B, projectA), []);
    const ownActivity = await activityRepo.listByTask(WS_B, taskB1);
    assert.ok(ownActivity.every((e) => e.workspaceId === WS_B));
  });

  it("fails closed when an event references a comment outside the listing's scope", async () => {
    // A (malformed) event on task A1 pointing at a live comment that belongs to task A2.
    await activityRepo.record({
      workspaceId: WS_A,
      projectId: projectA,
      taskId: taskA1,
      actorId: AUTHOR,
      type: "comment.created",
      details: { commentId: otherTaskLiveCommentId, mentions: [MENTION_1] },
    });
    const taskEvents = await activityRepo.listByTask(WS_A, taskA1);
    const stray = lifecycleEventsFor(taskEvents, otherTaskLiveCommentId).get("comment.created");
    assert.ok(stray);
    assertSafeDeletedCommentEvent(stray, otherTaskLiveCommentId, FORBIDDEN);

    // On its own task the comment is live, so its genuine event keeps attribution.
    const ownEvents = await activityRepo.listByTask(WS_A, taskA2);
    assert.equal(lifecycleEventsFor(ownEvents, otherTaskLiveCommentId).get("comment.created")?.actorId, AUTHOR);
  });

  it("redacts lifecycle events that carry no usable commentId", async () => {
    await activityRepo.record({
      workspaceId: WS_A,
      projectId: projectA,
      taskId: taskA2,
      actorId: AUTHOR,
      type: "comment.edited",
      details: { note: "no comment id" },
    });
    const events = await activityRepo.listByTask(WS_A, taskA2);
    const orphan = events.find((e) => e.type === "comment.edited" && e.details.commentId === undefined);
    assert.ok(orphan);
    assert.equal(orphan.actorId, null);
    assert.deepEqual(orphan.details, {});
  });

  it("uses one bounded batch lookup per page, never one query per event", async () => {
    const original = PostgresActivityRepository.prototype.findLiveCommentIds;
    const calls: string[][] = [];
    PostgresActivityRepository.prototype.findLiveCommentIds = async function (scope, ids) {
      calls.push([...ids]);
      return original.call(this, scope, ids);
    };
    try {
      for (let i = 0; i < 8; i++) {
        await commentRepo.create(WS_A, taskA1, { body: `bulk ${i}` }, { actorUserId: AUTHOR });
      }
      const events = await activityRepo.listByTask(WS_A, taskA1, 50);
      const lifecycleCount = events.filter((e) => e.type.startsWith("comment.")).length;
      assert.ok(lifecycleCount > 10, "the page must contain many comment events");
      assert.equal(calls.length, 1, "exactly one lookup for the whole page");
      assert.equal(new Set(calls[0]).size, calls[0]!.length, "lookup IDs are deduplicated");
      assert.ok(calls[0]!.length <= 50, "lookup is bounded by the page size");

      calls.length = 0;
      const nonCommentProject = await activityRepo.listByTask(WS_B, taskB1);
      assert.ok(nonCommentProject.every((e) => !e.type.startsWith("comment.")));
      assert.equal(calls.length, 0, "no lookup when a page has no comment events");
    } finally {
      PostgresActivityRepository.prototype.findLiveCommentIds = original;
    }
  });
});

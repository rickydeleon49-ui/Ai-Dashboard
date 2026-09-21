/**
 * Deleted-comment redaction on activity listings (SQLite / desktop).
 *
 * Mirrors tests/unit-pg/activity-redaction.test.ts and asserts through the same
 * shared helper, so both databases are held to one output shape. Desktop
 * rejects mentions at write time, so a stored event carrying mentions is
 * inserted directly to prove the redaction strips them here too.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db";
import {
  assertSafeDeletedCommentEvent,
  lifecycleEventsFor,
} from "../helpers/activity-redaction-expectations";
import { LOCAL_WORKSPACE_ID } from "../../src/db/repositories/project-repository";
import { DrizzleActivityRepository } from "../../src/db/repositories/drizzle-activity-repository";
import { db } from "../../src/db/client";
import { taskActivityEvents } from "../../src/db/schema";

let commentRepository: import("../../src/db/repositories/comment-repository").CommentRepository;
let activityRepository: DrizzleActivityRepository;

const AUTHOR = "desktop-author";
const DELETER = "desktop-deleter";
const MENTION_1 = "c3333333-3333-4333-8333-333333333333";
const MENTION_2 = "c4444444-4444-4444-8444-444444444444";
const FORBIDDEN = [AUTHOR, DELETER, MENTION_1, MENTION_2];

let projectId: string;
let taskId: string;
let otherTaskId: string;
let deletedCommentId: string;
let liveCommentId: string;
let otherTaskLiveCommentId: string;

before(async () => {
  await migrate();
  const repos = await import("../../src/db/repositories");
  commentRepository = repos.commentRepository;
  activityRepository = new DrizzleActivityRepository();

  projectId = (await repos.projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Redaction" })).id;
  taskId = (await repos.taskRepository.create(LOCAL_WORKSPACE_ID, { projectId, title: "T1" })).id;
  otherTaskId = (await repos.taskRepository.create(LOCAL_WORKSPACE_ID, { projectId, title: "T2" })).id;

  const doomed = await commentRepository.create(
    LOCAL_WORKSPACE_ID,
    taskId,
    { body: "secret plan" },
    { actorUserId: AUTHOR },
  );
  deletedCommentId = doomed.id;
  // What a created event with mentions looks like when stored; desktop can't write mentions itself.
  db.insert(taskActivityEvents)
    .values({
      id: crypto.randomUUID(),
      workspaceId: LOCAL_WORKSPACE_ID,
      projectId,
      taskId,
      actorId: AUTHOR,
      type: "comment.created",
      details: JSON.stringify({ commentId: doomed.id, mentions: [MENTION_1, MENTION_2] }),
      createdAt: new Date().toISOString(),
    })
    .run();
  await commentRepository.update(LOCAL_WORKSPACE_ID, taskId, doomed.id, { body: "v2" }, { actorUserId: AUTHOR });
  await commentRepository.delete(LOCAL_WORKSPACE_ID, taskId, doomed.id, { actorUserId: DELETER });

  liveCommentId = (
    await commentRepository.create(LOCAL_WORKSPACE_ID, taskId, { body: "still here" }, { actorUserId: AUTHOR })
  ).id;
  otherTaskLiveCommentId = (
    await commentRepository.create(LOCAL_WORKSPACE_ID, otherTaskId, { body: "on T2" }, { actorUserId: AUTHOR })
  ).id;
});

after(() => cleanup());

describe("Deleted-comment redaction on activity listings (SQLite)", () => {
  it("task activity hides the author, editor, deleter, and mentions of a deleted comment", async () => {
    const events = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, taskId);
    const deletedEvents = events.filter(
      (e) => e.type.startsWith("comment.") && e.details.commentId === deletedCommentId,
    );
    assert.equal(deletedEvents.length, 4, "two created events (one with mentions), one edited, one deleted");
    for (const event of deletedEvents) assertSafeDeletedCommentEvent(event, deletedCommentId, FORBIDDEN);
  });

  it("project activity applies the same redaction", async () => {
    const events = await activityRepository.listByProject(LOCAL_WORKSPACE_ID, projectId);
    const lifecycle = lifecycleEventsFor(events, deletedCommentId);
    assert.equal(lifecycle.size, 3);
    for (const event of lifecycle.values()) assertSafeDeletedCommentEvent(event, deletedCommentId, FORBIDDEN);
  });

  it("live comments keep actor attribution", async () => {
    const events = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, taskId);
    const created = lifecycleEventsFor(events, liveCommentId).get("comment.created");
    assert.ok(created);
    assert.equal(created.actorId, AUTHOR);
    assert.deepEqual(created.details, { commentId: liveCommentId });
  });

  it("leaves the stored activity rows unchanged", () => {
    const rows = db.select().from(taskActivityEvents).where(eq(taskActivityEvents.taskId, taskId)).all();
    const forDeleted = rows.filter((r) => JSON.parse(r.details).commentId === deletedCommentId);
    const withMentions = forDeleted.find((r) => JSON.parse(r.details).mentions);
    assert.ok(withMentions, "the stored mentions are still there");
    assert.deepEqual(JSON.parse(withMentions.details).mentions, [MENTION_1, MENTION_2]);
    assert.equal(forDeleted.find((r) => r.type === "comment.edited")?.actorId, AUTHOR);
    assert.equal(forDeleted.find((r) => r.type === "comment.deleted")?.actorId, DELETER);
  });

  it("keeps workspace scoping and fails closed for out-of-scope comment references", async () => {
    assert.deepEqual(await activityRepository.listByTask("some-other-workspace", taskId), []);
    assert.deepEqual(await activityRepository.listByProject("some-other-workspace", projectId), []);

    await activityRepository.record({
      workspaceId: LOCAL_WORKSPACE_ID,
      projectId,
      taskId,
      actorId: AUTHOR,
      type: "comment.created",
      details: { commentId: otherTaskLiveCommentId, mentions: [MENTION_1] },
    });
    const stray = lifecycleEventsFor(
      await activityRepository.listByTask(LOCAL_WORKSPACE_ID, taskId),
      otherTaskLiveCommentId,
    ).get("comment.created");
    assert.ok(stray);
    assertSafeDeletedCommentEvent(stray, otherTaskLiveCommentId, FORBIDDEN);
  });

  it("uses one bounded batch lookup per page", async () => {
    const original = DrizzleActivityRepository.prototype.findLiveCommentIds;
    const calls: string[][] = [];
    DrizzleActivityRepository.prototype.findLiveCommentIds = async function (scope, ids) {
      calls.push([...ids]);
      return original.call(this, scope, ids);
    };
    try {
      for (let i = 0; i < 8; i++) {
        await commentRepository.create(LOCAL_WORKSPACE_ID, taskId, { body: `bulk ${i}` }, { actorUserId: AUTHOR });
      }
      const events = await activityRepository.listByTask(LOCAL_WORKSPACE_ID, taskId, 50);
      assert.ok(events.filter((e) => e.type.startsWith("comment.")).length > 10);
      assert.equal(calls.length, 1, "exactly one lookup for the whole page");
      assert.equal(new Set(calls[0]).size, calls[0]!.length, "lookup IDs are deduplicated");
      assert.ok(calls[0]!.length <= 50, "lookup is bounded by the page size");
    } finally {
      DrizzleActivityRepository.prototype.findLiveCommentIds = original;
    }
  });
});

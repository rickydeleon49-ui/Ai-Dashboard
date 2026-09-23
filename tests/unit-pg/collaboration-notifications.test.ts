/**
 * Release 2C.6 collaboration notifications — PostgreSQL service & repository.
 *
 * Covers every category (assignment, unassignment, mention, comment, due date),
 * preference enforcement, the self-notification policy, recipient validity
 * (suspended / removed / invited / outsider / other workspace), duplicate
 * suppression, no-op and failed underlying operations, read/unread and
 * archive/restore transitions, mark-all-read bounds, unread counts, strict
 * cursor pagination across equal timestamps, deleted or inaccessible targets,
 * deleted-comment actor privacy, output sanitization of stored details, and
 * the mentioned-assignee precedence/fallback matrix across all four
 * mention/comment preference combinations.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db.pg";
import { U, W1, W2, seedNotificationWorld, type NotificationWorld } from "../helpers/notification-fixtures";
import type { CollaborationNotification } from "../../src/core/notifications/types";

let world: NotificationWorld;

before(async () => {
  await migrate();
  world = await seedNotificationWorld();
});

after(() => cleanup());

async function inbox(workspaceId: string, userId: string, view: "inbox" | "archived" = "inbox") {
  const all: CollaborationNotification[] = [];
  let cursor: string | undefined;
  do {
    const page = await world.notificationRepo.list(workspaceId, userId, {
      view,
      filter: "all",
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    all.push(...page.notifications);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return all;
}

async function rowsFor(userId: string) {
  return world.db
    .select()
    .from(world.schema.notifications)
    .where(eq(world.schema.notifications.recipientId, userId));
}

async function newTask(title: string, assigneeId?: string, workspaceId = W1, projectId = world.project1) {
  return world.taskRepo.create(
    workspaceId,
    { projectId, title, ...(assigneeId ? { assigneeId } : {}) },
    { actorUserId: U.alice },
  );
}

async function wipe() {
  await world.db.delete(world.schema.notifications);
  await world.db.delete(world.schema.notificationPreferences);
}

describe("Release 2C.6 notification generation", () => {
  it("assignment on create notifies the assignee, names the actor, and never the actor themself", async () => {
    await wipe();
    const task = await newTask("Assigned at creation", U.bob);
    const bob = await inbox(W1, U.bob);
    assert.equal(bob.length, 1);
    const n = bob[0]!;
    assert.equal(n.category, "assignment");
    assert.deepEqual(n.details, { change: "assigned" });
    assert.deepEqual(n.actor, { id: U.alice, name: "Alice Actor" });
    assert.deepEqual(n.task, { id: task.id, title: "Assigned at creation", projectId: world.project1 });
    assert.equal(n.project?.id, world.project1);
    assert.equal(n.read, false);
    assert.equal(n.archived, false);
    assert.equal((await rowsFor(U.alice)).length, 0);
  });

  it("self-assignment and a self-authored comment on one's own task create nothing", async () => {
    await wipe();
    const task = await world.taskRepo.create(
      W1,
      { projectId: world.project1, title: "Self assigned", assigneeId: U.alice },
      { actorUserId: U.alice },
    );
    await world.commentRepo.create(W1, task.id, { body: `Note to self @${U.alice}` }, { actorUserId: U.alice });
    assert.equal((await rowsFor(U.alice)).length, 0);
  });

  it("reassignment notifies the new assignee (assigned) and the previous one (unassigned)", async () => {
    await wipe();
    const task = await newTask("Reassign me", U.bob);
    await world.taskRepo.update(W1, task.id, { assigneeId: U.carol }, { actorUserId: U.alice });
    const carol = await inbox(W1, U.carol);
    const bob = await inbox(W1, U.bob);
    assert.deepEqual(carol.map((n) => n.details), [{ change: "assigned" }]);
    assert.deepEqual(
      bob.map((n) => n.details),
      [{ change: "unassigned" }, { change: "assigned" }],
    );

    await world.taskRepo.update(W1, task.id, { assigneeId: null }, { actorUserId: U.alice });
    const carolAfter = await inbox(W1, U.carol);
    assert.deepEqual(carolAfter[0]?.details, { change: "unassigned" });
  });

  it("a no-op update (same assignee, same calendar date) creates no notification", async () => {
    await wipe();
    const task = await newTask("No-op", U.bob);
    await world.taskRepo.update(W1, task.id, { dueDate: "2026-10-01" }, { actorUserId: U.alice });
    const before = (await rowsFor(U.bob)).length;
    const outcome = await world.taskRepo.updateAuthoritative(
      W1,
      task.id,
      { assigneeId: U.bob, dueDate: "2026-10-01" },
      { actorUserId: U.alice },
    );
    assert.equal(outcome?.unchanged, true);
    assert.equal((await rowsFor(U.bob)).length, before);
  });

  it("due-date set, move and clear notify the assignee with safe date-only details", async () => {
    await wipe();
    const task = await newTask("Due dates", U.bob);
    await world.db.delete(world.schema.notifications);

    await world.taskRepo.update(W1, task.id, { dueDate: "2026-10-01" }, { actorUserId: U.alice });
    await world.taskRepo.update(W1, task.id, { dueDate: "2026-10-05" }, { actorUserId: U.alice });
    await world.taskRepo.update(W1, task.id, { dueDate: null }, { actorUserId: U.alice });

    const bob = await inbox(W1, U.bob);
    assert.deepEqual(
      bob.map((n) => [n.category, n.details]),
      [
        ["due_date", { dueDate: null, previousDueDate: "2026-10-05" }],
        ["due_date", { dueDate: "2026-10-05", previousDueDate: "2026-10-01" }],
        ["due_date", { dueDate: "2026-10-01", previousDueDate: null }],
      ],
    );
  });

  it("a due-date change on an unassigned task notifies nobody", async () => {
    await wipe();
    const task = await newTask("Unassigned due");
    await world.taskRepo.update(W1, task.id, { dueDate: "2026-11-11" }, { actorUserId: U.alice });
    const all = await world.db.select().from(world.schema.notifications);
    assert.equal(all.length, 0);
  });

  it("assignment plus due date in one update sends only the assignment to the new assignee", async () => {
    await wipe();
    const task = await newTask("Assign and date");
    await world.taskRepo.update(
      W1,
      task.id,
      { assigneeId: U.carol, dueDate: "2026-12-01" },
      { actorUserId: U.alice },
    );
    const carol = await inbox(W1, U.carol);
    assert.deepEqual(carol.map((n) => n.category), ["assignment"]);
  });

  it("a failed update (invalid parent) rolls back its due-date notification with the change", async () => {
    await wipe();
    const task = await newTask("Will fail", U.bob);
    await world.db.delete(world.schema.notifications);
    await assert.rejects(() =>
      world.taskRepo.update(
        W1,
        task.id,
        { dueDate: "2026-09-30", parentTaskId: task.id },
        { actorUserId: U.alice },
      ),
    );
    assert.equal((await rowsFor(U.bob)).length, 0);
    const reread = await world.taskRepo.findById(W1, task.id);
    assert.equal(reread?.dueDate, null, "the underlying change rolled back too");
  });

  it("assigning a suspended member fails and notifies nobody", async () => {
    await wipe();
    const task = await newTask("Suspended target", U.bob);
    await world.db.delete(world.schema.notifications);
    await assert.rejects(() => world.taskRepo.update(W1, task.id, { assigneeId: U.sus }, { actorUserId: U.alice }));
    const all = await world.db.select().from(world.schema.notifications);
    assert.equal(all.length, 0, "neither the suspended user nor the previous assignee is notified");
  });

  it("mentions notify each mentioned active member once; the mentioned assignee gets a mention, not a comment", async () => {
    await wipe();
    const task = await newTask("Mentions", U.carol);
    await world.db.delete(world.schema.notifications);
    const comment = await world.commentRepo.create(
      W1,
      task.id,
      { body: `Hey @[Bob](${U.bob}) and @${U.carol} and again @${U.bob}` },
      { actorUserId: U.alice },
    );
    const bob = await inbox(W1, U.bob);
    const carol = await inbox(W1, U.carol);
    assert.deepEqual(bob.map((n) => n.category), ["mention"]);
    assert.deepEqual(carol.map((n) => n.category), ["mention"]);
    assert.deepEqual(bob[0]!.comment, { id: comment.id, deleted: false });
    assert.deepEqual(bob[0]!.details, {});
  });

  it("an invited member may be mentioned (2C.4 rule) but receives no notification until active", async () => {
    await wipe();
    const task = await newTask("Invited mention");
    await world.commentRepo.create(W1, task.id, { body: `@${U.inv} welcome` }, { actorUserId: U.alice });
    assert.equal((await rowsFor(U.inv)).length, 0);
  });

  it("a rejected mention (suspended member) creates no comment and no notification for anyone", async () => {
    await wipe();
    const task = await newTask("Rejected mention", U.bob);
    await world.db.delete(world.schema.notifications);
    await assert.rejects(() =>
      world.commentRepo.create(W1, task.id, { body: `@${U.sus} please` }, { actorUserId: U.alice }),
    );
    const all = await world.db.select().from(world.schema.notifications);
    assert.equal(all.length, 0);
  });

  it("a new comment notifies the task's assignee", async () => {
    await wipe();
    const task = await newTask("Commented", U.bob);
    await world.db.delete(world.schema.notifications);
    await world.commentRepo.create(W1, task.id, { body: "Progress update" }, { actorUserId: U.alice });
    const bob = await inbox(W1, U.bob);
    assert.deepEqual(bob.map((n) => n.category), ["comment"]);
    assert.deepEqual(bob[0]!.actor, { id: U.alice, name: "Alice Actor" });
  });

  it("stores no comment body, task title or other user content in the notification row", async () => {
    await wipe();
    const secret = "sk_live_SUPERSECRET <script>alert(1)</script>";
    const task = await newTask(`Title ${secret}`, U.bob);
    await world.commentRepo.create(W1, task.id, { body: `${secret} @${U.bob}` }, { actorUserId: U.alice });
    const rows = await rowsFor(U.bob);
    assert.ok(rows.length >= 2);
    for (const row of rows) {
      assert.ok(!JSON.stringify(row).includes("SUPERSECRET"), "notification rows must not copy user content");
    }
  });
});

describe("Release 2C.6 recipient validity at the writer", () => {
  it("drops suspended, removed, invited, outsider, other-workspace and actor recipients; dedupes ids", async () => {
    await wipe();
    const task = await newTask("Writer validity");
    const inserted = await world.insertNotificationDrafts(world.db, [
      {
        workspaceId: W1,
        category: "mention",
        sourceEventId: crypto.randomUUID(),
        actorId: U.alice,
        recipientIds: [U.bob, U.bob, U.sus, U.rem, U.inv, U.out, U.alice, "not-a-user"],
        taskId: task.id,
        projectId: world.project1,
        details: {},
      },
    ]);
    assert.equal(inserted, 1);
    const all = await world.db.select().from(world.schema.notifications);
    assert.deepEqual(all.map((r) => r.recipientId), [U.bob]);
  });

  it("processing the same event twice yields one row per recipient", async () => {
    await wipe();
    const task = await newTask("Duplicate event");
    const draft = {
      workspaceId: W1,
      category: "assignment" as const,
      sourceEventId: crypto.randomUUID(),
      actorId: U.alice,
      recipientIds: [U.bob, U.carol],
      taskId: task.id,
      projectId: world.project1,
      details: { change: "assigned" as const },
    };
    assert.equal(await world.insertNotificationDrafts(world.db, [draft]), 2);
    assert.equal(await world.insertNotificationDrafts(world.db, [draft]), 0);
    assert.equal(await world.insertNotificationDrafts(world.db, [draft, draft]), 0);
    const all = await world.db.select().from(world.schema.notifications);
    assert.equal(all.length, 2);
  });

  it("rejects an unknown category instead of writing it", async () => {
    await assert.rejects(() =>
      world.insertNotificationDrafts(world.db, [
        {
          workspaceId: W1,
          category: "digest" as never,
          sourceEventId: crypto.randomUUID(),
          actorId: U.alice,
          recipientIds: [U.bob],
          taskId: "x",
          projectId: world.project1,
          details: {},
        },
      ]),
    );
  });
});

describe("Release 2C.6 preferences", () => {
  it("defaults every category on", async () => {
    await wipe();
    assert.deepEqual(await world.notificationRepo.getPreferences(W1, U.bob), {
      assignment: true,
      mention: true,
      comment: true,
      due_date: true,
    });
  });

  it("partial updates change only the named category and are enforced at creation", async () => {
    await wipe();
    await world.notificationRepo.updatePreferences(W1, U.bob, { mention: false });
    const after = await world.notificationRepo.updatePreferences(W1, U.bob, { due_date: false });
    assert.deepEqual(after, { assignment: true, mention: false, comment: true, due_date: false });

    const task = await newTask("Prefs", U.bob);
    await world.commentRepo.create(W1, task.id, { body: `@${U.bob} look` }, { actorUserId: U.alice });
    await world.commentRepo.create(W1, task.id, { body: "plain comment" }, { actorUserId: U.alice });
    await world.taskRepo.update(W1, task.id, { dueDate: "2026-10-10" }, { actorUserId: U.alice });
    const categories = (await inbox(W1, U.bob)).map((n) => n.category).sort();
    assert.deepEqual(
      categories,
      ["assignment", "comment", "comment"],
      "due_date suppressed; the mention falls back to a comment notification because comments are still on",
    );

    await world.notificationRepo.updatePreferences(W1, U.bob, { mention: true });
    await world.commentRepo.create(W1, task.id, { body: `@${U.bob} again` }, { actorUserId: U.alice });
    assert.ok((await inbox(W1, U.bob)).some((n) => n.category === "mention"));
  });

  it("preferences are scoped to one workspace and one user", async () => {
    await wipe();
    await world.notificationRepo.updatePreferences(W1, U.bob, { assignment: false });
    assert.equal((await world.notificationRepo.getPreferences(W2, U.bob)).assignment, true);
    assert.equal((await world.notificationRepo.getPreferences(W1, U.carol)).assignment, true);

    const t2 = await world.taskRepo.create(
      W2,
      { projectId: world.project2, title: "W2 task", assigneeId: U.bob },
      { actorUserId: U.out },
    );
    assert.ok(t2.id);
    assert.equal((await inbox(W2, U.bob)).length, 1, "W2 assignment still delivered");
    await newTask("W1 suppressed", U.bob);
    assert.equal((await inbox(W1, U.bob)).length, 0);
  });

  it("the database rejects an unknown preference category", async () => {
    await assert.rejects(() =>
      world.db.insert(world.schema.notificationPreferences).values({
        workspaceId: W1,
        userId: U.bob,
        category: "digest",
        enabled: false,
      }),
    );
  });
});

describe("Release 2C.6 mentioned-assignee precedence and fallback", () => {
  // The assignee is in BOTH drafts; preferences and the unique constraint pick
  // exactly one. Every combination is checked end to end through the real
  // comment repository (design note §6.2).
  const CASES = [
    { mention: true, comment: true, expected: ["mention"] },
    { mention: true, comment: false, expected: ["mention"] },
    { mention: false, comment: true, expected: ["comment"] },
    { mention: false, comment: false, expected: [] },
  ] as const;

  for (const { mention, comment, expected } of CASES) {
    it(`mention ${mention ? "on" : "off"} + comment ${comment ? "on" : "off"} → ${
      expected.length ? `exactly one ${expected[0]}` : "nothing"
    }`, async () => {
      await wipe();
      const task = await newTask("Mentioned assignee", U.bob);
      await world.db.delete(world.schema.notifications);
      await world.notificationRepo.updatePreferences(W1, U.bob, { mention, comment });

      const created = await world.commentRepo.create(
        W1,
        task.id,
        { body: `@[Bob](${U.bob}) please look` },
        { actorUserId: U.alice },
      );

      const rows = await rowsFor(U.bob);
      assert.equal(rows.length, expected.length, "exactly one row, or none — never both, never a duplicate");
      assert.deepEqual(rows.map((r) => r.category), [...expected]);
      if (expected.length === 1) {
        assert.equal(rows[0]!.commentId, created.id);
        assert.ok(rows[0]!.sourceEventId, "carries the comment.created event id");
        const [shown] = await inbox(W1, U.bob);
        assert.equal(shown?.category, expected[0]);
      }
      // Whatever the preferences, the comment's author is never notified.
      assert.equal((await rowsFor(U.alice)).length, 0);
    });
  }

  it("keeps one row per recipient per comment when the assignee is mentioned repeatedly", async () => {
    await wipe();
    const task = await newTask("Repeat mention", U.bob);
    await world.db.delete(world.schema.notifications);
    await world.commentRepo.create(
      W1,
      task.id,
      { body: `@${U.bob} @[Bob](${U.bob}) @${U.bob}`, mentions: [U.bob] },
      { actorUserId: U.alice },
    );
    const rows = await rowsFor(U.bob);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.category, "mention");
  });

  it("a mentioned assignee commenting on their own task is still never notified", async () => {
    await wipe();
    const task = await newTask("Self mention", U.bob);
    await world.db.delete(world.schema.notifications);
    for (const prefs of [{ mention: true, comment: true }, { mention: false, comment: true }]) {
      await world.notificationRepo.updatePreferences(W1, U.bob, prefs);
      await world.commentRepo.create(W1, task.id, { body: `@${U.bob} note to self` }, { actorUserId: U.bob });
      assert.equal((await rowsFor(U.bob)).length, 0, JSON.stringify(prefs));
    }
  });

  it("a non-assignee mention still gets a mention, and the assignee still gets a comment", async () => {
    await wipe();
    const task = await newTask("Both recipients", U.bob);
    await world.db.delete(world.schema.notifications);
    await world.commentRepo.create(W1, task.id, { body: `@${U.carol} take a look` }, { actorUserId: U.alice });
    assert.deepEqual((await rowsFor(U.carol)).map((r) => r.category), ["mention"]);
    assert.deepEqual((await rowsFor(U.bob)).map((r) => r.category), ["comment"]);
  });
});

describe("Release 2C.6 lifecycle", () => {
  it("read/unread and archive/restore transitions, with idempotent first-read time", async () => {
    await wipe();
    await newTask("Lifecycle", U.bob);
    const [n] = await inbox(W1, U.bob);
    assert.ok(n);

    const read1 = await world.notificationRepo.updateState(W1, U.bob, n.id, { read: true });
    assert.equal(read1?.read, true);
    const read2 = await world.notificationRepo.updateState(W1, U.bob, n.id, { read: true });
    assert.equal(read2?.readAt, read1?.readAt, "marking read twice keeps the first read time");
    assert.equal(await world.notificationRepo.unreadCount(W1, U.bob), 0);

    const unread = await world.notificationRepo.updateState(W1, U.bob, n.id, { read: false });
    assert.equal(unread?.read, false);
    assert.equal(await world.notificationRepo.unreadCount(W1, U.bob), 1);

    const archived = await world.notificationRepo.updateState(W1, U.bob, n.id, { archived: true });
    assert.equal(archived?.archived, true);
    assert.equal(archived?.read, false, "archiving does not change read state");
    assert.equal(await world.notificationRepo.unreadCount(W1, U.bob), 0, "archived rows are not counted");
    assert.equal((await inbox(W1, U.bob)).length, 0);
    assert.equal((await inbox(W1, U.bob, "archived")).length, 1);

    const restored = await world.notificationRepo.updateState(W1, U.bob, n.id, { archived: false });
    assert.equal(restored?.archived, false);
    assert.equal((await inbox(W1, U.bob)).length, 1);

    const both = await world.notificationRepo.updateState(W1, U.bob, n.id, { read: true, archived: true });
    assert.equal(both?.read, true);
    assert.equal(both?.archived, true);
  });

  it("another user, another workspace, an unknown id and a malformed id all resolve to null and change nothing", async () => {
    await wipe();
    await newTask("Foreign ids", U.bob);
    const [n] = await inbox(W1, U.bob);
    assert.ok(n);
    assert.equal(await world.notificationRepo.updateState(W1, U.carol, n.id, { read: true }), null);
    assert.equal(await world.notificationRepo.updateState(W2, U.bob, n.id, { archived: true }), null);
    assert.equal(await world.notificationRepo.findById(W1, U.carol, n.id), null);
    assert.equal(await world.notificationRepo.findById(W2, U.bob, n.id), null);
    assert.equal(await world.notificationRepo.updateState(W1, U.bob, crypto.randomUUID(), { read: true }), null);
    assert.equal(await world.notificationRepo.updateState(W1, U.bob, "'; drop table notification; --", { read: true }), null);
    const [row] = await rowsFor(U.bob);
    assert.equal(row?.readAt, null);
    assert.equal(row?.archivedAt, null);
  });

  it("mark-all-read touches only the caller's rows in the active workspace, including archived ones", async () => {
    await wipe();
    await newTask("MAR W1 a", U.bob);
    const archivedTask = await newTask("MAR W1 b", U.bob);
    await newTask("MAR W1 carol", U.carol);
    await world.taskRepo.create(
      W2,
      { projectId: world.project2, title: "MAR W2", assigneeId: U.bob },
      { actorUserId: U.out },
    );
    const w1 = await inbox(W1, U.bob);
    const archivedOne = w1.find((n) => n.task?.id === archivedTask.id)!;
    await world.notificationRepo.updateState(W1, U.bob, archivedOne.id, { archived: true });

    const changed = await world.notificationRepo.markAllRead(W1, U.bob);
    assert.equal(changed, 2);
    assert.equal(await world.notificationRepo.unreadCount(W1, U.bob), 0);
    assert.equal((await inbox(W1, U.bob, "archived"))[0]?.read, true);
    assert.equal(await world.notificationRepo.unreadCount(W2, U.bob), 1, "other workspace untouched");
    assert.equal(await world.notificationRepo.unreadCount(W1, U.carol), 1, "other user untouched");
    assert.equal(await world.notificationRepo.markAllRead(W1, U.bob), 0, "idempotent");
  });

  it("unread counts are per workspace and per recipient", async () => {
    await wipe();
    await newTask("Count W1", U.bob);
    await newTask("Count W1 again", U.bob);
    await world.taskRepo.create(
      W2,
      { projectId: world.project2, title: "Count W2", assigneeId: U.bob },
      { actorUserId: U.out },
    );
    assert.equal(await world.notificationRepo.unreadCount(W1, U.bob), 2);
    assert.equal(await world.notificationRepo.unreadCount(W2, U.bob), 1);
    assert.equal(await world.notificationRepo.unreadCount(W2, U.carol), 0);
  });
});

describe("Release 2C.6 cursor pagination", () => {
  async function seedEqualTimestamps(count: number) {
    await wipe();
    const task = await newTask("Pagination");
    await world.db.delete(world.schema.notifications);
    const createdAt = new Date("2026-09-01T12:00:00.000Z");
    const rows = Array.from({ length: count }, () => ({
      id: crypto.randomUUID(),
      workspaceId: W1,
      recipientId: U.bob,
      actorId: U.alice,
      category: "comment",
      sourceEventId: crypto.randomUUID(),
      taskId: task.id,
      projectId: world.project1,
      createdAt,
    }));
    // A few at other timestamps on either side of the tie.
    rows.push(
      { ...rows[0]!, id: crypto.randomUUID(), sourceEventId: crypto.randomUUID(), createdAt: new Date("2026-09-02T00:00:00.000Z") },
      { ...rows[0]!, id: crypto.randomUUID(), sourceEventId: crypto.randomUUID(), createdAt: new Date("2026-08-31T00:00:00.000Z") },
    );
    await world.db.insert(world.schema.notifications).values(rows);
    return rows;
  }

  it("never skips or repeats rows when many share a timestamp, in deterministic created_at/id order", async () => {
    const rows = await seedEqualTimestamps(23);
    const expected = [...rows]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .map((r) => r.id);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await world.notificationRepo.list(W1, U.bob, {
        view: "inbox",
        filter: "all",
        limit: 4,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.notifications.map((n) => n.id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);

    assert.equal(pages, Math.ceil(expected.length / 4));
    assert.equal(new Set(seen).size, seen.length, "no duplicates");
    assert.deepEqual(seen, expected, "exact deterministic order, nothing skipped");
  });

  it("keeps position while rows change read state between pages of the unread filter", async () => {
    const rows = await seedEqualTimestamps(12);
    const first = await world.notificationRepo.list(W1, U.bob, { view: "inbox", filter: "unread", limit: 5 });
    for (const n of first.notifications) {
      await world.notificationRepo.updateState(W1, U.bob, n.id, { read: true });
    }
    const seen = first.notifications.map((n) => n.id);
    let cursor = first.nextCursor ?? undefined;
    while (cursor) {
      const page = await world.notificationRepo.list(W1, U.bob, { view: "inbox", filter: "unread", limit: 5, cursor });
      seen.push(...page.notifications.map((n) => n.id));
      cursor = page.nextCursor ?? undefined;
    }
    assert.equal(new Set(seen).size, rows.length);
  });

  it("rejects tampered cursors", async () => {
    const bad = [
      "not base64!",
      Buffer.from("[]").toString("base64url"),
      Buffer.from(JSON.stringify({ createdAt: "2026-09-01T12:00:00.000Z" })).toString("base64url"),
      Buffer.from(JSON.stringify({ createdAt: "2026-09-01", id: crypto.randomUUID() })).toString("base64url"),
      Buffer.from(JSON.stringify({ createdAt: "2026-09-01T12:00:00.000Z", id: "x' or 1=1" })).toString("base64url"),
      Buffer.from(
        JSON.stringify({ createdAt: "2026-09-01T12:00:00.000Z", id: crypto.randomUUID(), extra: 1 }),
      ).toString("base64url"),
      "a".repeat(600),
    ];
    for (const cursor of bad) {
      await assert.rejects(
        () => world.notificationRepo.list(W1, U.bob, { view: "inbox", filter: "all", limit: 5, cursor }),
        /cursor/i,
        cursor,
      );
    }
  });
});

describe("Release 2C.6 deleted and inaccessible targets", () => {
  it("a deleted task leaves the notification with task null; a deleted project leaves project null", async () => {
    await wipe();
    const project = await world.projectRepo.create(W1, { name: "Doomed project" });
    const task = await newTask("Doomed task", U.bob, W1, project.id);
    await world.taskRepo.delete(W1, task.id);
    let [n] = await inbox(W1, U.bob);
    assert.ok(n, "history survives task deletion");
    assert.equal(n.task, null);
    assert.equal(n.project?.id, project.id);

    await world.projectRepo.delete(W1, project.id);
    [n] = await inbox(W1, U.bob);
    assert.ok(n);
    assert.equal(n.project, null);
  });

  it("a soft-deleted comment hides the actor of its mention and comment notifications", async () => {
    await wipe();
    const task = await newTask("Deleted comment", U.carol);
    await world.db.delete(world.schema.notifications);
    const comment = await world.commentRepo.create(W1, task.id, { body: `@${U.bob} hi` }, { actorUserId: U.alice });
    await world.commentRepo.delete(W1, task.id, comment.id, { actorUserId: U.alice });
    for (const user of [U.bob, U.carol]) {
      const [n] = await inbox(W1, user);
      assert.ok(n);
      assert.equal(n.actor, null, "actor withheld once the comment is deleted");
      assert.deepEqual(n.comment, { id: comment.id, deleted: true });
    }
  });

  it("never renders a task or project from another workspace, even for a corrupted row", async () => {
    await wipe();
    const w1Task = await newTask("W1 private title");
    await world.db.insert(world.schema.notifications).values({
      id: crypto.randomUUID(),
      workspaceId: W2,
      recipientId: U.bob,
      actorId: U.alice,
      category: "assignment",
      sourceEventId: crypto.randomUUID(),
      taskId: w1Task.id,
      projectId: world.project1,
      details: { change: "assigned" },
    });
    const [n] = await inbox(W2, U.bob);
    assert.ok(n);
    assert.equal(n.task, null);
    assert.equal(n.project, null);
    assert.equal(n.actor, null, "Alice is not a member of W2");
  });

  it("strips unexpected keys from stored details on output", async () => {
    await wipe();
    const task = await newTask("Details");
    await world.db.insert(world.schema.notifications).values({
      id: crypto.randomUUID(),
      workspaceId: W1,
      recipientId: U.bob,
      actorId: U.alice,
      category: "due_date",
      sourceEventId: crypto.randomUUID(),
      taskId: task.id,
      projectId: world.project1,
      details: { dueDate: "2026-01-02", previousDueDate: "<b>x</b>", body: "secret", token: "t" },
    });
    const [n] = await inbox(W1, U.bob);
    assert.deepEqual(n?.details, { dueDate: "2026-01-02", previousDueDate: null });
  });

  it("deleting a workspace or a recipient account removes their notifications", async () => {
    await wipe();
    const tmpUser = crypto.randomUUID();
    await world.db.insert(world.schema.users).values({ id: tmpUser, name: "Temp", email: `${tmpUser}@x.test` });
    await world.db.insert(world.schema.workspaceMembers).values({ workspaceId: W1, userId: tmpUser, role: "member" });
    await newTask("For temp", tmpUser);
    assert.equal((await rowsFor(tmpUser)).length, 1);
    await world.db.delete(world.schema.users).where(eq(world.schema.users.id, tmpUser));
    assert.equal((await rowsFor(tmpUser)).length, 0);

    const tmpWs = `ws-tmp-${crypto.randomBytes(3).toString("hex")}`;
    await world.db.insert(world.schema.workspaces).values({ id: tmpWs, name: "Tmp", slug: tmpWs, kind: "team" });
    await world.db.insert(world.schema.workspaceMembers).values([
      { workspaceId: tmpWs, userId: U.alice, role: "owner" },
      { workspaceId: tmpWs, userId: U.bob, role: "member" },
    ]);
    const proj = await world.projectRepo.create(tmpWs, { name: "Tmp project" });
    await world.taskRepo.create(tmpWs, { projectId: proj.id, title: "Tmp", assigneeId: U.bob }, { actorUserId: U.alice });
    const inTmp = () =>
      world.db
        .select()
        .from(world.schema.notifications)
        .where(and(eq(world.schema.notifications.workspaceId, tmpWs)));
    assert.equal((await inTmp()).length, 1);
    await world.db.delete(world.schema.workspaces).where(eq(world.schema.workspaces.id, tmpWs));
    assert.equal((await inTmp()).length, 0);
  });
});

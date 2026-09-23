/**
 * Release 2C.6 collaboration notifications — PostgreSQL concurrency.
 *
 * Proves, against a real PostgreSQL 16 server with genuinely concurrent
 * connections from the pool:
 * - concurrent duplicate processing of one event creates one row per recipient
 * - identical concurrent assignments produce one change and one notification
 * - concurrent read + archive on one row both apply; read/unread races stay consistent
 * - mark-all-read racing with new notifications in another workspace never touches that workspace
 * - concurrent partial preference updates to different categories all persist;
 *   same-category races leave exactly one row
 * - preference changes racing notification creation follow the documented
 *   statement-snapshot semantics (never a half state, never retroactive deletion)
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { and, eq, isNull } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db.pg";
import { U, W1, W2, seedNotificationWorld, type NotificationWorld } from "../helpers/notification-fixtures";

let world: NotificationWorld;

before(async () => {
  await migrate();
  world = await seedNotificationWorld();
});

after(() => cleanup());

async function wipe() {
  await world.db.delete(world.schema.notifications);
  await world.db.delete(world.schema.notificationPreferences);
}

function rowsWhere(recipientId: string, workspaceId = W1) {
  return world.db
    .select()
    .from(world.schema.notifications)
    .where(
      and(
        eq(world.schema.notifications.recipientId, recipientId),
        eq(world.schema.notifications.workspaceId, workspaceId),
      ),
    );
}

describe("Release 2C.6 PostgreSQL concurrency", () => {
  it("20 concurrent transactions processing the same event insert exactly one row per recipient", async () => {
    await wipe();
    const task = await world.taskRepo.create(W1, { projectId: world.project1, title: "Dup event" }, { actorUserId: U.alice });
    const draft = {
      workspaceId: W1,
      category: "mention" as const,
      sourceEventId: crypto.randomUUID(),
      actorId: U.alice,
      recipientIds: [U.bob, U.carol],
      taskId: task.id,
      projectId: world.project1,
      details: {},
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        world.db.transaction((tx) => world.insertNotificationDrafts(tx, [draft])),
      ),
    );
    assert.equal(results.reduce((a, b) => a + b, 0), 2, "exactly two inserts in total");
    assert.equal((await rowsWhere(U.bob)).length, 1);
    assert.equal((await rowsWhere(U.carol)).length, 1);
  });

  it("10 identical concurrent assignments produce one change and one notification", async () => {
    await wipe();
    const task = await world.taskRepo.create(W1, { projectId: world.project1, title: "Race assign" }, { actorUserId: U.alice });
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () =>
        world.taskRepo.updateAuthoritative(W1, task.id, { assigneeId: U.bob }, { actorUserId: U.alice }),
      ),
    );
    assert.equal(outcomes.filter((o) => o && !o.unchanged).length, 1);
    const rows = await rowsWhere(U.bob);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.category, "assignment");
  });

  it("concurrent bulk-style updates across many tasks notify once per materially changed task", async () => {
    await wipe();
    const tasks = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        world.taskRepo.create(W1, { projectId: world.project1, title: `Bulk ${i}` }, { actorUserId: U.alice }),
      ),
    );
    // Two overlapping "bulk" passes assigning the same tasks to Carol at once.
    await Promise.all(
      [0, 1].map(() =>
        Promise.all(
          tasks.map((t) =>
            world.taskRepo.updateAuthoritative(W1, t.id, { assigneeId: U.carol }, { actorUserId: U.alice }),
          ),
        ),
      ),
    );
    const rows = await rowsWhere(U.carol);
    assert.equal(rows.length, tasks.length);
    assert.equal(new Set(rows.map((r) => r.taskId)).size, tasks.length);
  });

  it("concurrent read and archive of one notification both apply (repeated 15 times)", async () => {
    for (let i = 0; i < 15; i += 1) {
      await wipe();
      await world.taskRepo.create(
        W1,
        { projectId: world.project1, title: `RA ${i}`, assigneeId: U.bob },
        { actorUserId: U.alice },
      );
      const [row] = await rowsWhere(U.bob);
      assert.ok(row);
      const [a, b] = await Promise.all([
        world.notificationRepo.updateState(W1, U.bob, row.id, { read: true }),
        world.notificationRepo.updateState(W1, U.bob, row.id, { archived: true }),
      ]);
      assert.ok(a && b);
      const [final] = await rowsWhere(U.bob);
      assert.ok(final?.readAt, "read survived");
      assert.ok(final?.archivedAt, "archive survived");
    }
  });

  it("concurrent read/unread toggles leave one consistent row", async () => {
    await wipe();
    await world.taskRepo.create(
      W1,
      { projectId: world.project1, title: "Toggle", assigneeId: U.bob },
      { actorUserId: U.alice },
    );
    const [row] = await rowsWhere(U.bob);
    assert.ok(row);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        world.notificationRepo.updateState(W1, U.bob, row.id, { read: i % 2 === 0 }),
      ),
    );
    const rows = await rowsWhere(U.bob);
    assert.equal(rows.length, 1);
    const count = await world.notificationRepo.unreadCount(W1, U.bob);
    assert.equal(count, rows[0]!.readAt === null ? 1 : 0, "count agrees with the row");
  });

  it("mark-all-read in W1 racing new W2 notifications never touches W2", async () => {
    await wipe();
    for (let i = 0; i < 5; i += 1) {
      await world.taskRepo.create(
        W1,
        { projectId: world.project1, title: `MAR ${i}`, assigneeId: U.bob },
        { actorUserId: U.alice },
      );
    }
    await Promise.all([
      world.notificationRepo.markAllRead(W1, U.bob),
      ...Array.from({ length: 5 }, (_, i) =>
        world.taskRepo.create(
          W2,
          { projectId: world.project2, title: `W2 ${i}`, assigneeId: U.bob },
          { actorUserId: U.out },
        ),
      ),
      world.notificationRepo.markAllRead(W1, U.bob),
    ]);
    assert.equal(await world.notificationRepo.unreadCount(W1, U.bob), 0);
    const w2Unread = await world.db
      .select()
      .from(world.schema.notifications)
      .where(
        and(
          eq(world.schema.notifications.workspaceId, W2),
          eq(world.schema.notifications.recipientId, U.bob),
          isNull(world.schema.notifications.readAt),
        ),
      );
    assert.equal(w2Unread.length, 5);
  });

  it("concurrent partial preference updates to different categories all persist", async () => {
    await wipe();
    await Promise.all([
      world.notificationRepo.updatePreferences(W1, U.bob, { assignment: false }),
      world.notificationRepo.updatePreferences(W1, U.bob, { mention: false }),
      world.notificationRepo.updatePreferences(W1, U.bob, { comment: false }),
      world.notificationRepo.updatePreferences(W1, U.bob, { due_date: false }),
    ]);
    assert.deepEqual(await world.notificationRepo.getPreferences(W1, U.bob), {
      assignment: false,
      mention: false,
      comment: false,
      due_date: false,
    });
  });

  it("same-category preference races leave exactly one row holding one of the written values", async () => {
    await wipe();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        world.notificationRepo.updatePreferences(W1, U.bob, { mention: i % 2 === 0 }),
      ),
    );
    const rows = await world.db
      .select()
      .from(world.schema.notificationPreferences)
      .where(
        and(
          eq(world.schema.notificationPreferences.workspaceId, W1),
          eq(world.schema.notificationPreferences.userId, U.bob),
        ),
      );
    assert.equal(rows.length, 1);
    assert.equal(typeof rows[0]?.enabled, "boolean");
  });

  it("preference toggles racing generation never produce duplicates or delete existing rows", async () => {
    await wipe();
    const task = await world.taskRepo.create(W1, { projectId: world.project1, title: "Pref race" }, { actorUserId: U.alice });
    await world.commentRepo.create(W1, task.id, { body: `@${U.bob} first` }, { actorUserId: U.alice });
    const baseline = (await rowsWhere(U.bob)).length;
    assert.equal(baseline, 1);

    await Promise.all([
      ...Array.from({ length: 6 }, (_, i) =>
        world.commentRepo.create(W1, task.id, { body: `@${U.bob} race ${i}` }, { actorUserId: U.alice }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        world.notificationRepo.updatePreferences(W1, U.bob, { mention: i % 2 === 1 }),
      ),
    ]);
    const rows = await rowsWhere(U.bob);
    assert.ok(rows.length >= baseline, "a preference change never deletes existing notifications");
    assert.ok(rows.length <= baseline + 6);
    assert.equal(new Set(rows.map((r) => r.sourceEventId)).size, rows.length, "no duplicate per event");

    // After the race settles, the stored preference is authoritative for new events.
    await world.notificationRepo.updatePreferences(W1, U.bob, { mention: false });
    const settled = (await rowsWhere(U.bob)).length;
    await world.commentRepo.create(W1, task.id, { body: `@${U.bob} after` }, { actorUserId: U.alice });
    assert.equal((await rowsWhere(U.bob)).length, settled);
  });

  it("the unique index rejects a raw duplicate (recipient, source_event_id) outright", async () => {
    await wipe();
    const task = await world.taskRepo.create(W1, { projectId: world.project1, title: "Raw dup" }, { actorUserId: U.alice });
    const base = {
      workspaceId: W1,
      recipientId: U.bob,
      actorId: U.alice,
      category: "comment",
      sourceEventId: crypto.randomUUID(),
      taskId: task.id,
      projectId: world.project1,
    };
    await world.db.insert(world.schema.notifications).values({ ...base, id: crypto.randomUUID() });
    await assert.rejects(
      () => world.db.insert(world.schema.notifications).values({ ...base, id: crypto.randomUUID() }),
      (err: unknown) => {
        const e = err as { code?: string; cause?: { code?: string } };
        assert.equal(e.code ?? e.cause?.code, "23505");
        return true;
      },
    );
  });
});

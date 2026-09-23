/**
 * Release 2C.6 collaboration notifications — pure logic and desktop behavior.
 *
 * 1. Strict cursor decoding (length, charset, JSON shape, canonical timestamp, UUID id).
 * 2. Strict request schemas: unknown fields/categories, non-booleans, empty
 *    updates and malformed limits are rejected; partial updates keep only the
 *    keys provided.
 * 3. Output allowlist for stored details.
 * 4. Desktop mode deliberately has no collaboration inbox: every /api/inbox
 *    route answers 404 without writing anything, desktop comments and task
 *    changes create no notification rows, and SQLite gains no collaboration table.
 * 5. No production module exposes a notification test hook or override.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { cleanup, migrate, testRoot } from "../helpers/db";
import { LOCAL_WORKSPACE_ID } from "../../src/db/repositories/project-repository";
import {
  InvalidNotificationCursorError,
  decodeNotificationCursor,
  encodeNotificationCursor,
} from "../../src/core/notifications/cursor";
import {
  notificationListQuerySchema,
  notificationPreferencesUpdateSchema,
  notificationStateChangeSchema,
  searchParamsToObject,
} from "../../src/core/notifications/schema";
import { sanitizeNotificationDetails, toDateOnly } from "../../src/core/notifications/details";

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

const ID = "3f1c2a4e-9b7d-4c1e-8a2b-1234567890ab";

before(() => migrate());
after(() => cleanup());

describe("notification cursor", () => {
  it("round-trips a valid cursor", () => {
    const cursor = { createdAt: "2026-09-21T10:11:12.345Z", id: ID };
    assert.deepEqual(decodeNotificationCursor(encodeNotificationCursor(cursor)), cursor);
  });

  it("rejects every malformed cursor", () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const bad = [
      "",
      "a".repeat(513),
      "has spaces",
      "abc+/=",
      Buffer.from("not json").toString("base64url"),
      enc(null),
      enc([ID]),
      enc({ id: ID }),
      enc({ createdAt: "2026-09-21T10:11:12.345Z", id: ID, x: 1 }),
      enc({ createdAt: "2026-09-21T10:11:12.345Z", id: "not-a-uuid" }),
      enc({ createdAt: "2026-09-21T10:11:12.345Z", id: 42 }),
      enc({ createdAt: "2026-09-21", id: ID }),
      enc({ createdAt: "2026-09-21T10:11:12Z", id: ID }),
      enc({ createdAt: "2026-02-30T10:11:12.345Z", id: ID }),
      enc({ createdAt: "2026-09-21T10:11:12.345+02:00", id: ID }),
      enc({ createdAt: 1789900000000, id: ID }),
    ];
    for (const cursor of bad) {
      assert.throws(() => decodeNotificationCursor(cursor), InvalidNotificationCursorError, cursor);
    }
  });
});

describe("notification request schemas", () => {
  it("list query: defaults, bounds, strictness", () => {
    assert.deepEqual(notificationListQuerySchema.parse({}), { view: "inbox", filter: "all", limit: 20 });
    assert.deepEqual(notificationListQuerySchema.parse({ view: "archived", filter: "unread", limit: "50" }), {
      view: "archived",
      filter: "unread",
      limit: 50,
    });
    for (const bad of [
      { limit: "0" },
      { limit: "51" },
      { limit: "1.5" },
      { limit: "-1" },
      { limit: "01" },
      { limit: "abc" },
      { view: "all" },
      { filter: "read" },
      { workspaceId: "ws" },
      { recipientId: "u" },
    ]) {
      assert.equal(notificationListQuerySchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
    assert.equal(searchParamsToObject(new URLSearchParams("view=inbox&view=archived")), null);
  });

  it("state change: booleans only, at least one, no extra fields", () => {
    assert.deepEqual(notificationStateChangeSchema.parse({ read: true }), { read: true });
    assert.deepEqual(notificationStateChangeSchema.parse({ archived: false }), { archived: false });
    for (const bad of [{}, { read: "true" }, { archived: 1 }, { read: true, recipientId: "x" }, null, []]) {
      assert.equal(notificationStateChangeSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });

  it("preferences: known categories only, booleans only, partial updates keep only given keys", () => {
    assert.deepEqual(notificationPreferencesUpdateSchema.parse({ mention: false }), { mention: false });
    assert.deepEqual(notificationPreferencesUpdateSchema.parse({ due_date: true, comment: false }), {
      due_date: true,
      comment: false,
    });
    for (const bad of [
      {},
      { email: true },
      { mention: "false" },
      { mention: null },
      { mention: false, userId: "someone-else" },
      { dueDate: true },
    ]) {
      assert.equal(notificationPreferencesUpdateSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });
});

describe("notification details allowlist", () => {
  it("keeps only the documented fields for each category", () => {
    assert.deepEqual(sanitizeNotificationDetails("assignment", { change: "unassigned", body: "x" }), {
      change: "unassigned",
    });
    assert.deepEqual(sanitizeNotificationDetails("assignment", { change: "<script>" }), { change: "assigned" });
    assert.deepEqual(
      sanitizeNotificationDetails("due_date", { dueDate: "2026-01-01", previousDueDate: "tomorrow", token: "t" }),
      { dueDate: "2026-01-01", previousDueDate: null },
    );
    assert.deepEqual(sanitizeNotificationDetails("mention", { body: "secret", mentions: ["a"] }), {});
    assert.deepEqual(sanitizeNotificationDetails("comment", "not an object"), {});
    assert.equal(toDateOnly("2026-10-01"), "2026-10-01");
    assert.equal(toDateOnly(new Date("2026-10-01T23:00:00.000Z")), "2026-10-01");
    assert.equal(toDateOnly(null), null);
    assert.equal(toDateOnly("garbage"), null);
  });
});

describe("desktop mode: collaboration notifications deliberately omitted", () => {
  function req(method: string, url: string, body?: unknown) {
    return new NextRequest(`http://localhost${url}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  it("every /api/inbox route returns 404 outside accounts mode", async () => {
    assert.notEqual(process.env.AUTH_MODE, "accounts");
    assert.equal(process.env.DATABASE_URL, undefined);
    const list = await import("../../src/app/api/inbox/route");
    const count = await import("../../src/app/api/inbox/unread-count/route");
    const item = await import("../../src/app/api/inbox/[id]/route");
    const markAll = await import("../../src/app/api/inbox/mark-all-read/route");
    const prefs = await import("../../src/app/api/inbox/preferences/route");
    const params = { params: Promise.resolve({ id: ID }) };
    const responses = [
      await list.GET(req("GET", "/api/inbox")),
      await count.GET(req("GET", "/api/inbox/unread-count")),
      await item.PATCH(req("PATCH", `/api/inbox/${ID}`, { read: true }), params),
      await markAll.POST(req("POST", "/api/inbox/mark-all-read")),
      await prefs.GET(req("GET", "/api/inbox/preferences")),
      await prefs.PATCH(req("PATCH", "/api/inbox/preferences", { mention: false })),
    ];
    for (const response of responses) {
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  });

  it("desktop task assignment-free changes and comments create no collaboration notification storage", async () => {
    const { projectRepository, taskRepository, commentRepository } = await import("../../src/db/repositories");
    const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Desktop notif project" });
    const task = await taskRepository.create(LOCAL_WORKSPACE_ID, { projectId: project.id, title: "Desktop task" });
    await taskRepository.update(LOCAL_WORKSPACE_ID, task.id, { dueDate: "2026-10-01" });
    await commentRepository.create(LOCAL_WORKSPACE_ID, task.id, { body: "desktop comment" });

    const { withLegacySqliteAccess, sqlite } = await import("../../src/db/client");
    await withLegacySqliteAccess(async () => {
      const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
        .map((r) => r.name);
      assert.ok(!tables.includes("notification"), "no collaboration notification table in SQLite");
      assert.ok(!tables.includes("notification_preference"));
      const automation = sqlite.prepare("SELECT * FROM notifications").all();
      assert.equal(automation.length, 0, "the desktop automation inbox is not written by collaboration events");
    });
    assert.ok(fs.existsSync(path.join(testRoot, "test.db")));
  });

  it("SQLite repositories contain no notification generation, and the inbox is PostgreSQL-only", () => {
    const repoDir = path.join(process.cwd(), "src", "db", "repositories");
    for (const file of fs.readdirSync(repoDir).filter((f) => f.startsWith("drizzle-"))) {
      const source = fs.readFileSync(path.join(repoDir, file), "utf8");
      assert.doesNotMatch(source, /notification/i, `${file} must not generate collaboration notifications`);
    }
    const inboxRepo = fs.readFileSync(path.join(repoDir, "postgres-notification-repository.ts"), "utf8");
    assert.doesNotMatch(inboxRepo, /better-sqlite3|\.\.\/client"|schema"\s*;?$/m);
  });

  it("no notification production module exposes a test hook or mutable override", () => {
    const src = path.join(process.cwd(), "src");
    const files = [
      ...["core/notifications", "app/api/inbox", "components/notifications"].flatMap((dir) => walk(path.join(src, dir))),
      path.join(src, "db/repositories/postgres-notification-repository.ts"),
      path.join(src, "db/repositories/notification-repository.ts"),
      path.join(src, "db/repositories/postgres-task-repository.ts"),
      path.join(src, "db/repositories/postgres-comment-repository.ts"),
    ];
    assert.ok(files.length >= 12);
    const offenders = files.filter((file) =>
      /ForTest|ForTesting|__test|Override|let\s+\w+\s*:\s*\(\(/.test(fs.readFileSync(file, "utf8")),
    );
    assert.deepEqual(offenders, []);
  });
});

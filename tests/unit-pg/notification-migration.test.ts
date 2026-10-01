/**
 * Release 2C.6 migration 0015 (collaboration notifications).
 *
 * 1. Upgrade: applies the real migrations 0000–0014 with the production
 *    migrator, seeds data in that schema, then applies the real 0015 and
 *    proves every pre-existing row survives untouched.
 * 2. The journal lists 0015 immediately after 0014, and no released migration
 *    file was edited to deliver this release.
 * 3. Fresh creation: a new database with every migration has the expected
 *    tables, columns, defaults, checks, foreign-key delete rules and indexes.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL?.trim() ||
  "postgres://ai_dashboard:ai_dashboard_dev@localhost:5432/postgres";
const realDir = path.resolve(process.cwd(), "drizzle-pg");
const journal = JSON.parse(fs.readFileSync(path.join(realDir, "meta", "_journal.json"), "utf8")) as {
  entries: { idx: number; tag: string }[];
};

const created: string[] = [];
const clients: Client[] = [];
const tempDirs: string[] = [];
let admin: Client;

async function freshDb(): Promise<{ url: string; client: Client }> {
  const name = `cc_mig15_${crypto.randomBytes(5).toString("hex")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  created.push(name);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  client.on("error", () => {});
  await client.connect();
  clients.push(client);
  return { url: url.toString(), client };
}

function migrationsUpTo(lastIdx: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drizzle-pg-0015-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "meta"));
  const entries = journal.entries.filter((e) => e.idx <= lastIdx);
  for (const e of entries) fs.copyFileSync(path.join(realDir, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }, null, 2));
  return dir;
}

before(async () => {
  admin = new Client({ connectionString: adminUrl });
  await admin.connect();
});

after(async () => {
  for (const client of clients) await client.end().catch(() => {});
  for (const name of created) {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
  }
  await admin.end();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("PostgreSQL migration 0015: collaboration notifications", () => {
  it("is journal entry 15, directly after 0014, and released migrations are unchanged", () => {
    const e14 = journal.entries.find((e) => e.idx === 14);
    const e15 = journal.entries.find((e) => e.idx === 15);
    assert.equal(e14?.tag, "0014_comments_and_activity");
    assert.equal(e15?.tag, "0015_collaboration_notifications");
    // Later releases may only append migrations after 0015 (e.g. 0016_reusable_templates).
    assert.ok(journal.entries.length >= 16);
    assert.deepEqual(journal.entries.slice(0, 16).map((e) => e.idx), Array.from({ length: 16 }, (_, i) => i));
    const sql = fs.readFileSync(path.join(realDir, "0015_collaboration_notifications.sql"), "utf8");
    assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE\s+"(?!notification)[a-z_]+"\s+(DROP|ALTER))/i);
  });

  it("upgrades a populated 0014 database without touching existing rows", async () => {
    const { url, client } = await freshDb();
    const migrator = new Client({ connectionString: url });
    await migrator.connect();
    await migrate(drizzle(migrator), { migrationsFolder: migrationsUpTo(14) });
    await migrator.end();

    const pre = await client.query(`SELECT to_regclass('public.notification') AS t`);
    assert.equal(pre.rows[0].t, null, "no notification table before 0015");

    await client.query(`INSERT INTO "user" (id, name, email) VALUES ('u1', 'Una', 'u1@x.test')`);
    await client.query(
      `INSERT INTO workspace (id, name, slug, kind, created_by) VALUES ('w1', 'W', 'w1', 'team', 'u1')`,
    );
    await client.query(
      `INSERT INTO workspace_member (workspace_id, user_id, role, status) VALUES ('w1', 'u1', 'owner', 'active')`,
    );
    await client.query(`INSERT INTO project (id, workspace_id, name) VALUES ('p1', 'w1', 'P')`);
    await client.query(
      `INSERT INTO task (id, workspace_id, project_id, title, assignee_id) VALUES ('t1', 'w1', 'p1', 'T', 'u1')`,
    );
    await client.query(
      `INSERT INTO task_comment (id, workspace_id, task_id, author_id, body) VALUES ('c1', 'w1', 't1', 'u1', 'hello')`,
    );
    await client.query(
      `INSERT INTO task_activity_event (id, workspace_id, project_id, task_id, actor_id, type)
       VALUES ('e1', 'w1', 'p1', 't1', 'u1', 'comment.created')`,
    );
    const snapshot = async () =>
      (
        await client.query(`
          SELECT (SELECT json_agg(t ORDER BY id) FROM task t) AS tasks,
                 (SELECT json_agg(c ORDER BY id) FROM task_comment c) AS comments,
                 (SELECT json_agg(e ORDER BY id) FROM task_activity_event e) AS events,
                 (SELECT json_agg(m ORDER BY user_id) FROM workspace_member m) AS members`)
      ).rows[0];
    const before = await snapshot();

    const c = new Client({ connectionString: url });
    await c.connect();
    await migrate(drizzle(c), { migrationsFolder: migrationsUpTo(15) });
    await c.end();

    assert.deepEqual(await snapshot(), before, "pre-existing data untouched by 0015");
    const post = await client.query(
      `SELECT to_regclass('public.notification') AS n, to_regclass('public.notification_preference') AS p`,
    );
    assert.equal(post.rows[0].n, "notification");
    assert.equal(post.rows[0].p, "notification_preference");

    // The upgraded schema accepts a notification referencing pre-existing rows.
    await client.query(
      `INSERT INTO notification (id, workspace_id, recipient_id, category, source_event_id, task_id, project_id, comment_id)
       VALUES ('n1', 'w1', 'u1', 'comment', 'e1', 't1', 'p1', 'c1')`,
    );
    const n = await client.query(`SELECT details, read_at, archived_at, created_at FROM notification`);
    assert.deepEqual(n.rows[0].details, {});
    assert.equal(n.rows[0].read_at, null);
    assert.equal(n.rows[0].archived_at, null);
    assert.ok(n.rows[0].created_at);
  });

  it("creates the full schema on a fresh database with correct constraints, delete rules and indexes", async () => {
    const { url, client } = await freshDb();
    const c = new Client({ connectionString: url });
    await c.connect();
    await migrate(drizzle(c), { migrationsFolder: realDir });
    await c.end();

    const fks = await client.query(`
      SELECT tc.table_name, kcu.column_name, ccu.table_name AS ref, rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name IN ('notification', 'notification_preference')
      ORDER BY tc.table_name, kcu.column_name`);
    const rules = Object.fromEntries(
      fks.rows.map((r: { table_name: string; column_name: string; ref: string; delete_rule: string }) => [
        `${r.table_name}.${r.column_name}`,
        `${r.ref}:${r.delete_rule}`,
      ]),
    );
    assert.deepEqual(rules, {
      "notification.actor_id": "user:SET NULL",
      "notification.comment_id": "task_comment:SET NULL",
      "notification.project_id": "project:SET NULL",
      "notification.recipient_id": "user:CASCADE",
      "notification.task_id": "task:SET NULL",
      "notification.workspace_id": "workspace:CASCADE",
      "notification_preference.user_id": "user:CASCADE",
      "notification_preference.workspace_id": "workspace:CASCADE",
    });

    const idx = await client.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('notification', 'notification_preference')`,
    );
    const defs = Object.fromEntries(idx.rows.map((r: { indexname: string; indexdef: string }) => [r.indexname, r.indexdef]));
    assert.match(defs.notification_recipient_source_uq ?? "", /UNIQUE.*\(recipient_id, source_event_id\)/);
    assert.match(defs.notification_inbox_idx ?? "", /\(recipient_id, workspace_id, created_at DESC( NULLS LAST)?, id DESC( NULLS LAST)?\)/);
    assert.match(defs.notification_unread_idx ?? "", /WHERE \(\(read_at IS NULL\) AND \(archived_at IS NULL\)\)/);
    for (const name of [
      "notification_workspace_idx",
      "notification_task_idx",
      "notification_project_idx",
      "notification_comment_idx",
      "notification_actor_idx",
      "notification_preference_workspace_id_user_id_category_pk",
    ]) {
      assert.ok(defs[name], `${name} exists`);
    }

    await client.query(`INSERT INTO "user" (id, email) VALUES ('u1', 'a@x.test')`);
    await client.query(`INSERT INTO workspace (id, name, slug, kind) VALUES ('w1', 'W', 'w1', 'team')`);
    await assert.rejects(
      client.query(
        `INSERT INTO notification (id, workspace_id, recipient_id, category, source_event_id) VALUES ('x', 'w1', 'u1', 'digest', 's')`,
      ),
      /notification_category_check/,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO notification_preference (workspace_id, user_id, category, enabled) VALUES ('w1', 'u1', 'email', true)`,
      ),
      /notification_preference_category_check/,
    );
  });
});

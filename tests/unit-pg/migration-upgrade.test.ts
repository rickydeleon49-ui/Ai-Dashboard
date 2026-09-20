/**
 * PostgreSQL Migration Upgrade Test:
 * Recreates the real pre-0008 schema by applying migrations 0000 through 0007
 * using the production Drizzle migrator mechanism.
 *
 * Verifies:
 * 1. Historical migrations 0000-0007 apply completely without dropping comment-prefixed SQL.
 * 2. Pre-0008 triggers (e.g. workspace_member_last_owner from 0002) and constraints exist.
 * 3. Historical data seeded under pre-0008 schema (with real columns: id, name, slug, kind, created_by).
 * 4. Preexisting ownership claim with projects_imported = 0 exists without a status column.
 * 5. Real migration 0008 applies cleanly via production migrator.
 * 6. Post-0008 constraints updated (workspace.created_by nullable, ON DELETE SET NULL).
 * 7. Preexisting 0-project claim row backfills to status = 'completed'.
 * 8. The completed claim cannot be re-claimed by any user (rejects with already_claimed).
 * 9. Fails loudly if any historical migration is missing or skipped.
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

const dbName = `cc_upgrade_${crypto.randomBytes(6).toString("hex")}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${dbName}`;

let client: Client;
let adminClient: Client;
let tempMigrationsDir: string;
let tempSqliteDir: string;
let originalDatabasePath: string | undefined;

const realMigrationsDir = path.resolve(process.cwd(), "drizzle-pg");

describe("PostgreSQL migration 0008 upgrade: historical schema recreation & claim backfill", () => {
  before(async () => {
    adminClient = new Client({ connectionString: adminUrl });
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE "${dbName}"`);

    client = new Client({ connectionString: testUrl.toString() });
    await client.connect();

    // 1. Prepare temporary migrations directory with exact production structure
    tempMigrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), "drizzle-pg-upgrade-"));
    const tempMetaDir = path.join(tempMigrationsDir, "meta");
    fs.mkdirSync(tempMetaDir, { recursive: true });

    // Read real production journal
    const realJournalPath = path.join(realMigrationsDir, "meta", "_journal.json");
    if (!fs.existsSync(realJournalPath)) {
      throw new Error(`Real migration journal missing at ${realJournalPath}`);
    }
    const realJournal = JSON.parse(fs.readFileSync(realJournalPath, "utf8")) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    };

    // Assert historical migrations 0000-0007 exist in journal
    const expectedPre0008Tags = [
      "0000_striped_magik",
      "0001_steep_nehzno",
      "0002_workspace_last_owner_trigger",
      "0003_solid_bullseye",
      "0004_luxuriant_the_initiative",
      "0005_tricky_ultimates",
      "0006_sleepy_excalibur",
      "0007_blue_annihilus",
    ];

    if (realJournal.entries.length < 9) {
      throw new Error(
        `Expected at least 9 migration entries in journal (0000-0008), found ${realJournal.entries.length}`,
      );
    }

    for (let i = 0; i < expectedPre0008Tags.length; i++) {
      const entry = realJournal.entries[i];
      if (!entry || entry.tag !== expectedPre0008Tags[i]) {
        throw new Error(
          `Historical migration sequence mismatch at index ${i}: expected ${expectedPre0008Tags[i]}, found ${entry?.tag}`,
        );
      }
      const sqlSource = path.join(realMigrationsDir, `${entry.tag}.sql`);
      if (!fs.existsSync(sqlSource)) {
        throw new Error(`Historical migration file missing: ${sqlSource}`);
      }
      fs.copyFileSync(sqlSource, path.join(tempMigrationsDir, `${entry.tag}.sql`));
    }

    // Write partial journal with only 0000..0007
    const pre0008Journal = {
      version: realJournal.version,
      dialect: realJournal.dialect,
      entries: realJournal.entries.slice(0, 8),
    };
    fs.writeFileSync(path.join(tempMetaDir, "_journal.json"), JSON.stringify(pre0008Journal, null, 2));

    // 2. Apply migrations 0000 through 0007 using production Drizzle migrator
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: tempMigrationsDir });
  });

  it("proves real pre-0008 triggers and constraints exist, seeds historical data, and upgrades cleanly with 0008", async () => {
    // 1. Confirm important pre-0008 triggers and constraints exist before applying 0008:
    // a. workspace_member_last_owner trigger from migration 0002 must exist
    const triggerRes = await client.query(
      `SELECT tgname FROM pg_trigger WHERE tgname = 'workspace_member_last_owner'`,
    );
    assert.equal(
      triggerRes.rows.length,
      1,
      "Migration 0002 trigger 'workspace_member_last_owner' must exist in pre-0008 schema",
    );

    // b. workspace_created_by_user_id_fk constraint must exist and have ON DELETE CASCADE (confdeltype = 'c')
    const fkRes = await client.query(
      `SELECT conname, confdeltype FROM pg_constraint WHERE conname = 'workspace_created_by_user_id_fk'`,
    );
    assert.equal(fkRes.rows.length, 1, "Constraint 'workspace_created_by_user_id_fk' must exist");
    assert.equal(
      fkRes.rows[0].confdeltype,
      "c",
      "Pre-0008 workspace.created_by FK must be ON DELETE CASCADE",
    );

    // c. workspace.created_by must be NOT NULL in pre-0008
    const colRes = await client.query(
      `SELECT attname, attnotnull FROM pg_attribute WHERE attrelid = 'workspace'::regclass AND attname = 'created_by'`,
    );
    assert.equal(colRes.rows.length, 1);
    assert.equal(colRes.rows[0].attnotnull, true, "Pre-0008 workspace.created_by must be NOT NULL");

    // d. ownership_claim must not have status or imported_project_ids columns yet
    const claimCols = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'ownership_claim'`,
    );
    const existingClaimCols = new Set(claimCols.rows.map((r) => r.column_name));
    assert.ok(existingClaimCols.has("id"));
    assert.ok(existingClaimCols.has("claimed_by"));
    assert.ok(existingClaimCols.has("workspace_id"));
    assert.ok(existingClaimCols.has("projects_imported"));
    assert.equal(existingClaimCols.has("status"), false, "pre-0008 ownership_claim must not have status");
    assert.equal(
      existingClaimCols.has("imported_project_ids"),
      false,
      "pre-0008 ownership_claim must not have imported_project_ids",
    );

    // 2. Seed data using the REAL historical schema
    const userId = "pre0008_user_historical";
    const workspaceId = "pre0008_ws_historical";

    await client.query(
      `INSERT INTO "user" ("id", "name", "email") VALUES ($1, 'Historical Claimant', 'claimant@example.com')`,
      [userId],
    );

    // Workspace with real historical columns: id, name, slug, kind, created_by
    await client.query(
      `INSERT INTO "workspace" ("id", "name", "slug", "kind", "created_by")
       VALUES ($1, 'Historical Personal', 'historical-personal-ws', 'personal', $2)`,
      [workspaceId, userId],
    );

    await client.query(
      `INSERT INTO "workspace_member" ("workspace_id", "user_id", "role") VALUES ($1, $2, 'owner')`,
      [workspaceId, userId],
    );

    // Seed ownership claim with projects_imported = 0 (created under pre-0008 one-shot semantics)
    await client.query(
      `INSERT INTO "ownership_claim" ("id", "claimed_by", "workspace_id", "projects_imported", "claimed_at")
       VALUES ('singleton', $1, $2, 0, now())`,
      [userId, workspaceId],
    );

    // Verify row was inserted into pre-0008 schema
    const preRow = await client.query(`SELECT * FROM "ownership_claim" WHERE "id" = 'singleton'`);
    assert.equal(preRow.rows.length, 1);
    assert.equal(preRow.rows[0].projects_imported, 0);
    assert.equal(preRow.rows[0].status, undefined);

    // 3. Prepare real migration 0008 in the temporary migrations directory
    const realJournal = JSON.parse(
      fs.readFileSync(path.join(realMigrationsDir, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };

    const migration0008Tag = realJournal.entries[8]?.tag;
    if (migration0008Tag !== "0008_safe_workspace_lifecycle_and_resumable_claims") {
      throw new Error(`Expected entry 8 to be 0008 migration, found: ${migration0008Tag}`);
    }

    const sql0008Source = path.join(realMigrationsDir, `${migration0008Tag}.sql`);
    if (!fs.existsSync(sql0008Source)) {
      throw new Error(`Migration 0008 SQL file missing at ${sql0008Source}`);
    }
    fs.copyFileSync(sql0008Source, path.join(tempMigrationsDir, `${migration0008Tag}.sql`));

    // Update journal to include migration 0008
    const upgradedJournal = {
      version: "7",
      dialect: "postgresql",
      entries: realJournal.entries.slice(0, 9),
    };
    fs.writeFileSync(
      path.join(tempMigrationsDir, "meta", "_journal.json"),
      JSON.stringify(upgradedJournal, null, 2),
    );

    // 4. Run migration 0008 using production Drizzle migrator
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: tempMigrationsDir });

    // 5. Verify post-0008 schema alterations:
    // a. workspace.created_by is now nullable
    const postColRes = await client.query(
      `SELECT attname, attnotnull FROM pg_attribute WHERE attrelid = 'workspace'::regclass AND attname = 'created_by'`,
    );
    assert.equal(postColRes.rows[0].attnotnull, false, "Post-0008 workspace.created_by must be nullable");

    // b. workspace_created_by_user_id_fk is now ON DELETE SET NULL (confdeltype = 'n')
    const postFkRes = await client.query(
      `SELECT conname, confdeltype FROM pg_constraint WHERE conname = 'workspace_created_by_user_id_fk'`,
    );
    assert.equal(
      postFkRes.rows[0].confdeltype,
      "n",
      "Post-0008 workspace.created_by FK must be ON DELETE SET NULL",
    );

    // 6. Verify preexisting 0-project claim was backfilled to status = 'completed'
    const postClaimRes = await client.query(`SELECT * FROM "ownership_claim" WHERE "id" = 'singleton'`);
    assert.equal(postClaimRes.rows.length, 1);
    const upgradedClaim = postClaimRes.rows[0];

    assert.equal(
      upgradedClaim.status,
      "completed",
      "preexisting 0-project claim must backfill to 'completed'",
    );
    assert.equal(upgradedClaim.projects_imported, 0);
    assert.deepEqual(upgradedClaim.imported_project_ids, []);
    assert.equal(upgradedClaim.last_error, null);

    // 7. Verify pre-0009 workspace_member does not have status, then apply migration 0009
    const pre0009MemberCols = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'workspace_member'`,
    );
    const existingMemberCols = new Set(pre0009MemberCols.rows.map((r) => r.column_name));
    assert.equal(existingMemberCols.has("status"), false, "pre-0009 workspace_member must not have status");

    const migration0009Tag = realJournal.entries[9]?.tag;
    if (migration0009Tag !== "0009_workspace_member_status") {
      throw new Error(`Expected entry 9 to be 0009 migration, found: ${migration0009Tag}`);
    }
    const sql0009Source = path.join(realMigrationsDir, `${migration0009Tag}.sql`);
    if (!fs.existsSync(sql0009Source)) {
      throw new Error(`Migration 0009 SQL file missing at ${sql0009Source}`);
    }
    fs.copyFileSync(sql0009Source, path.join(tempMigrationsDir, `${migration0009Tag}.sql`));

    const upgradedJournal0009 = {
      version: "7",
      dialect: "postgresql",
      entries: realJournal.entries.slice(0, 10),
    };
    fs.writeFileSync(
      path.join(tempMigrationsDir, "meta", "_journal.json"),
      JSON.stringify(upgradedJournal0009, null, 2),
    );

    await migrate(db, { migrationsFolder: tempMigrationsDir });

    // Verify post-0009 workspace_member schema and backfill:
    // a. Existing member row backfilled to 'active'
    const postMemberRes = await client.query(
      `SELECT status FROM "workspace_member" WHERE "workspace_id" = $1 AND "user_id" = $2`,
      [workspaceId, userId],
    );
    assert.equal(postMemberRes.rows.length, 1);
    assert.equal(
      postMemberRes.rows[0].status,
      "active",
      "preexisting workspace_member must backfill to 'active'",
    );

    // b. workspace_member_status_check constraint exists and rejects invalid status
    const attackerId = "pre0008_attacker";
    await client.query(
      `INSERT INTO "user" ("id", "name", "email") VALUES ($1, 'Attacker', 'attacker@example.com')`,
      [attackerId],
    );
    await assert.rejects(
      () =>
        client.query(
          `INSERT INTO "workspace_member" ("workspace_id", "user_id", "role", "status") VALUES ($1, $2, 'member', 'invalid_status')`,
          [workspaceId, attackerId],
        ),
      /workspace_member_status_check/,
      "status constraint must reject invalid status values",
    );

    // c. Apply migration 0010: last active owner trigger
    const migration0010Tag = realJournal.entries[10]?.tag;
    if (migration0010Tag !== "0010_last_active_owner_trigger") {
      throw new Error(`Expected entry 10 to be 0010 migration, found: ${migration0010Tag}`);
    }
    const sql0010Source = path.join(realMigrationsDir, `${migration0010Tag}.sql`);
    if (!fs.existsSync(sql0010Source)) {
      throw new Error(`Migration 0010 SQL file missing at ${sql0010Source}`);
    }
    fs.copyFileSync(sql0010Source, path.join(tempMigrationsDir, `${migration0010Tag}.sql`));

    const upgradedJournal0010 = {
      version: "7",
      dialect: "postgresql",
      entries: realJournal.entries.slice(0, 11),
    };
    fs.writeFileSync(
      path.join(tempMigrationsDir, "meta", "_journal.json"),
      JSON.stringify(upgradedJournal0010, null, 2),
    );

    await migrate(db, { migrationsFolder: tempMigrationsDir });

    // d. Apply migration 0011: last active owner lock
    const migration0011Tag = realJournal.entries[11]?.tag;
    if (migration0011Tag !== "0011_last_active_owner_lock") {
      throw new Error(`Expected entry 11 to be 0011 migration, found: ${migration0011Tag}`);
    }
    const sql0011Source = path.join(realMigrationsDir, `${migration0011Tag}.sql`);
    if (!fs.existsSync(sql0011Source)) {
      throw new Error(`Migration 0011 SQL file missing at ${sql0011Source}`);
    }
    fs.copyFileSync(sql0011Source, path.join(tempMigrationsDir, `${migration0011Tag}.sql`));

    const upgradedJournal0011 = {
      version: "7",
      dialect: "postgresql",
      entries: realJournal.entries.slice(0, 12),
    };
    fs.writeFileSync(
      path.join(tempMigrationsDir, "meta", "_journal.json"),
      JSON.stringify(upgradedJournal0011, null, 2),
    );

    await migrate(db, { migrationsFolder: tempMigrationsDir });

    // 8. Verify the completed claim cannot be reclaimed by the original user or any other user
    process.env.DATABASE_URL = testUrl.toString();
    process.env.DASHBOARD_PASSWORD = "test-dashboard-password";

    originalDatabasePath = process.env.DATABASE_PATH;
    tempSqliteDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-upgrade-sqlite-"));
    process.env.DATABASE_PATH = path.join(tempSqliteDir, "legacy-temp.db");

    const { isAlreadyClaimed, claimOwnership, OwnershipClaimError } = await import(
      "../../src/core/ownership-claim/service"
    );

    assert.equal(await isAlreadyClaimed(), true, "isAlreadyClaimed must return true for upgraded claim");

    // Original claimant cannot reclaim
    await assert.rejects(
      () => claimOwnership(userId, "test-dashboard-password"),
      (err: unknown) => {
        assert.ok(err instanceof OwnershipClaimError);
        assert.equal(err.reason, "already_claimed");
        return true;
      },
    );

    // Different user cannot reclaim
    await assert.rejects(
      () => claimOwnership(attackerId, "test-dashboard-password"),
      (err: unknown) => {
        assert.ok(err instanceof OwnershipClaimError);
        assert.equal(err.reason, "already_claimed");
        return true;
      },
    );
  });

  after(async () => {
    try {
      const { closePgPool } = await import("../../src/db/pg-client");
      await closePgPool();
    } catch {
      // ignore if pg-client wasn't initialized
    }
    if (client) {
      try {
        await client.end();
      } catch {
        // ignore
      }
    }
    if (adminClient) {
      try {
        await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await adminClient.end();
      } catch {
        // ignore
      }
    }
    if (tempMigrationsDir && fs.existsSync(tempMigrationsDir)) {
      try {
        fs.rmSync(tempMigrationsDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    try {
      const { closeConnection } = await import("../../src/db/client");
      closeConnection();
    } catch {
      // ignore
    }
    if (originalDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = originalDatabasePath;
    }
    if (tempSqliteDir && fs.existsSync(tempSqliteDir)) {
      try {
        fs.rmSync(tempSqliteDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

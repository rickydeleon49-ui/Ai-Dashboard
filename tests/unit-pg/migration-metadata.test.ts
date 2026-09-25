/**
 * A freshly migrated PostgreSQL 16 database matches the final drizzle-pg
 * snapshot (and therefore src/db/schema.pg.ts — tests/unit/migration-metadata
 * proves those two are identical).
 *
 * This is the check that found the only real drift in the repaired chain:
 * schema.pg.ts declared `workspace_personal_owner_idx` with a predicate no
 * migration ever created. Drizzle snapshots describe tables, columns, indexes,
 * keys and check constraints; the hand-written functions and triggers from
 * migrations 0002, 0010 and 0011 are not part of any snapshot, so their
 * presence is asserted here and their behaviour is covered by the member and
 * migration-upgrade suites.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";
import {
  at,
  comparableStructure,
  pullSnapshot,
  readJournal,
  readSnapshot,
  snapshotFiles,
  structureDifferences,
} from "../helpers/drizzle-metadata";

async function query<T>(sql: string): Promise<T[]> {
  const { withPgClient } = await import("../../src/db/pg-client");
  return withPgClient(async (client) => (await client.query(sql)).rows as T[]);
}

describe("drizzle-pg: a fresh PostgreSQL database matches the final snapshot", () => {
  before(migrate);
  after(cleanup);

  it("runs on PostgreSQL 16 or later and applies every journaled migration", async () => {
    const version = at(await query<{ server_version_num: string }>("show server_version_num"), 0);
    assert.ok(Number(version.server_version_num) >= 160000, "PostgreSQL 16+");
    const applied = at(await query<{ n: string }>("select count(*) as n from drizzle.__drizzle_migrations"), 0);
    assert.equal(Number(applied.n), readJournal("postgresql").entries.length);
  });

  it("introspects to exactly the final snapshot's tables, columns, indexes, keys and checks", () => {
    const files = snapshotFiles("postgresql");
    const expected = comparableStructure(readSnapshot("postgresql", at(files, -1)));
    const actual = comparableStructure(pullSnapshot("postgresql", String(process.env.DATABASE_URL)));
    assert.deepEqual(structureDifferences(actual, expected), []);
  });

  it("keeps the hand-written objects no snapshot records", async () => {
    const triggers = await query<{ tgname: string }>(
      `select tgname from pg_trigger where tgrelid = 'workspace_member'::regclass and not tgisinternal`,
    );
    assert.deepEqual(triggers.map((t) => t.tgname), ["workspace_member_last_owner"]);
    const fn = await query<{ src: string }>(`select prosrc as src from pg_proc where proname = 'prevent_last_owner_removal'`);
    assert.equal(fn.length, 1);
    // 0011's version: locks the workspace row and checks ACTIVE owners.
    assert.match(at(fn, 0).src, /FOR UPDATE/);
    assert.match(at(fn, 0).src, /status = 'active'/);
  });
});

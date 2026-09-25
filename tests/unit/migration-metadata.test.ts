/**
 * Drizzle migration metadata stays consistent with the migrations and schema.
 *
 * drizzle-kit plans the next migration by diffing the schema file against the
 * last snapshot in `<dir>/meta/`. When migrations 0008+ were committed without
 * snapshots, `db:generate` wanted to re-create every table they had added. These
 * checks keep the journal, the SQL files, the snapshot chain, the schema files
 * and a freshly migrated SQLite database in agreement, and prove generation is
 * a no-op — all without a database server (the PostgreSQL database check is in
 * tests/unit-pg/migration-metadata.test.ts).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db";
import {
  DIALECTS,
  at,
  comparableStructure,
  generateAgainstCopy,
  migrationsDir,
  pullSnapshot,
  readJournal,
  readSnapshot,
  snapshotContents,
  snapshotFiles,
  structureDifferences,
  type Dialect,
} from "../helpers/drizzle-metadata";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function serializedSchema(dialect: Dialect): Promise<Record<string, unknown>> {
  const api = await import("drizzle-kit/api");
  if (dialect === "sqlite") {
    return (await api.generateSQLiteDrizzleJson(await import("../../src/db/schema"))) as never;
  }
  return api.generateDrizzleJson(await import("../../src/db/schema.pg")) as never;
}

for (const dialect of ["sqlite", "postgresql"] as const) {
  const { dir, snapshotVersion, journalVersion, firstPrevId } = DIALECTS[dialect];

  describe(`${dir}: migration metadata`, () => {
    const journal = readJournal(dialect);
    const entries = journal.entries;

    it("the journal is for this dialect and its entries are contiguous and unique", () => {
      assert.equal(journal.dialect, dialect);
      assert.ok(entries.length > 0);
      entries.forEach((e, i) => {
        assert.equal(e.idx, i, `entry ${i} has idx ${e.idx}`);
        assert.equal(e.version, journalVersion, `${e.tag} journal version`);
        assert.ok(e.tag.startsWith(`${String(i).padStart(4, "0")}_`), `${e.tag} is numbered ${i}`);
        assert.equal(e.breakpoints, true, `${e.tag} uses statement breakpoints`);
        if (i > 0) assert.ok(e.when > at(entries, i - 1).when, `${e.tag} is later than ${at(entries, i - 1).tag}`);
      });
      assert.equal(new Set(entries.map((e) => e.tag)).size, entries.length, "tags are unique");
    });

    it("every journal entry has its SQL migration, and every SQL migration is journaled", () => {
      const sqlFiles = fs.readdirSync(migrationsDir(dialect)).filter((f) => f.endsWith(".sql")).sort();
      assert.deepEqual(sqlFiles, entries.map((e) => `${e.tag}.sql`));
      for (const e of entries) {
        const sql = fs.readFileSync(path.join(migrationsDir(dialect), `${e.tag}.sql`), "utf8");
        assert.ok(sql.trim().length > 0, `${e.tag}.sql is not empty`);
      }
    });

    it("every migration has exactly one snapshot, of this dialect and snapshot version", () => {
      // Each migration — including hand-written, trigger-only ones — records the
      // schema state after it, as `drizzle-kit generate --custom` does.
      assert.deepEqual(
        snapshotFiles(dialect),
        entries.map((e) => `${String(e.idx).padStart(4, "0")}_snapshot.json`),
      );
      for (const file of snapshotFiles(dialect)) {
        const s = readSnapshot(dialect, file);
        assert.equal(s.dialect, dialect, `${file} dialect`);
        assert.equal(s.version, snapshotVersion, `${file} version`);
        assert.match(s.id, UUID, `${file} id`);
        assert.ok(s.tables && typeof s.tables === "object", `${file} has tables`);
      }
    });

    it("snapshot ids are unique and prevIds form one continuous chain in migration order", () => {
      const snaps = snapshotFiles(dialect).map((f) => ({ file: f, ...readSnapshot(dialect, f) }));
      assert.equal(new Set(snaps.map((s) => s.id)).size, snaps.length, "snapshot ids are unique");
      assert.equal(at(snaps, 0).prevId, firstPrevId, `${at(snaps, 0).file} starts the chain`);
      for (let i = 1; i < snaps.length; i++) {
        assert.equal(at(snaps, i).prevId, at(snaps, i - 1).id, `${at(snaps, i).file}.prevId is ${at(snaps, i - 1).file}.id`);
      }
      // drizzle-kit refuses to run when two snapshots share a parent.
      assert.equal(new Set(snaps.map((s) => s.prevId)).size, snaps.length, "no two snapshots share a prevId");
    });

    it("the final snapshot is exactly the current schema file, as drizzle-kit serializes it", async () => {
      const files = snapshotFiles(dialect);
      const last = readSnapshot(dialect, at(files, -1));
      const current = await serializedSchema(dialect);
      assert.equal(snapshotContents(last as never), snapshotContents(current));
    });

    it("drizzle-kit generate finds nothing to migrate and writes nothing", () => {
      const result = generateAgainstCopy(dialect);
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /No schema changes, nothing to migrate/);
      assert.deepEqual(result.changed, [], "no migration SQL, journal edit or snapshot was produced");
    });

    it("drift is detected: without the last snapshot, generate re-creates what that migration added", () => {
      // What happened before this repair, reproduced on a throwaway copy: the
      // check must fail loudly, not pass vacuously.
      const lastEntry = at(entries, -1);
      const lastSnapshot = `${String(lastEntry.idx).padStart(4, "0")}_snapshot.json`;
      const result = generateAgainstCopy(dialect, (copy) => fs.rmSync(path.join(copy, "meta", lastSnapshot)));
      assert.equal(result.status, 0, result.output);
      const next = String(entries.length).padStart(4, "0");
      assert.ok(
        result.changed.some((f) => f.startsWith(`${next}_`) && f.endsWith(".sql")),
        `a duplicate migration ${next}_*.sql was generated: ${result.changed.join(", ")}`,
      );
      assert.ok(result.changed.includes("meta/_journal.json"));
    });
  });
}

describe("drizzle: a fresh SQLite database matches the final snapshot", () => {
  after(cleanup);

  it("applies every migration and introspects to the final snapshot's structure", async () => {
    await migrate();
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(process.env.DATABASE_PATH!, { readonly: true });
    const applied = db.prepare("select count(*) as n from __drizzle_migrations").get() as { n: number };
    db.close();
    assert.equal(applied.n, readJournal("sqlite").entries.length, "every journaled migration was applied");

    const files = snapshotFiles("sqlite");
    const expected = comparableStructure(readSnapshot("sqlite", at(files, -1)));
    const actual = comparableStructure(pullSnapshot("sqlite", process.env.DATABASE_PATH!));
    assert.deepEqual(structureDifferences(actual, expected), []);
  });
});

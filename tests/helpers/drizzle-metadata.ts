/**
 * Helpers for the migration-metadata tests (tests/unit/migration-metadata.test.ts
 * and tests/unit-pg/migration-metadata.test.ts).
 *
 * drizzle-kit decides what a new migration must contain by diffing the schema
 * file against the LAST snapshot in `<out>/meta/` (sorted by filename); the
 * journal is never consulted for that. A migration committed without its
 * snapshot therefore makes the next `db:generate` re-create everything since
 * the last snapshot. These helpers read the committed metadata, run
 * drizzle-kit against a throwaway copy of a migrations folder (never the
 * checkout), and reduce snapshots to a comparable structure.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Dialect = "sqlite" | "postgresql";

const REPO = process.cwd();
const DRIZZLE_KIT = path.join(REPO, "node_modules", "drizzle-kit", "bin.cjs");

export const DIALECTS: Record<
  Dialect,
  { dir: string; schema: string; snapshotVersion: string; journalVersion: string; firstPrevId: string }
> = {
  sqlite: {
    dir: "drizzle",
    schema: "src/db/schema.ts",
    snapshotVersion: "6",
    journalVersion: "6",
    firstPrevId: "00000000-0000-0000-0000-000000000000",
  },
  postgresql: {
    dir: "drizzle-pg",
    schema: "src/db/schema.pg.ts",
    snapshotVersion: "7",
    journalVersion: "7",
    firstPrevId: "00000000-0000-0000-0000-000000000000",
  },
};

export interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

export interface Snapshot {
  id: string;
  prevId: string;
  version: string;
  dialect: string;
  tables: Record<string, TableSnapshot>;
  [key: string]: unknown;
}

interface TableSnapshot {
  name: string;
  columns: Record<string, { type: string; primaryKey?: boolean; notNull?: boolean; default?: unknown; autoincrement?: boolean }>;
  indexes: Record<string, { columns: unknown[]; isUnique: boolean; where?: string; method?: string }>;
  foreignKeys: Record<string, { tableTo: string; columnsFrom: string[]; columnsTo: string[]; onDelete?: string; onUpdate?: string }>;
  compositePrimaryKeys: Record<string, { columns: string[] }>;
  uniqueConstraints: Record<string, { columns: string[] }>;
  checkConstraints?: Record<string, { value: string }>;
}

/** `list[index]`, failing loudly instead of yielding undefined. */
export function at<T>(list: readonly T[], index: number): T {
  const value = list[index < 0 ? list.length + index : index];
  if (value === undefined) throw new Error(`no element at ${index} (length ${list.length})`);
  return value;
}

export function migrationsDir(dialect: Dialect): string {
  return path.join(REPO, DIALECTS[dialect].dir);
}

export function readJournal(dialect: Dialect): { version: string; dialect: string; entries: JournalEntry[] } {
  return JSON.parse(fs.readFileSync(path.join(migrationsDir(dialect), "meta", "_journal.json"), "utf8"));
}

/** Snapshot files in the order drizzle-kit reads them (sorted by filename). */
export function snapshotFiles(dialect: Dialect): string[] {
  return fs
    .readdirSync(path.join(migrationsDir(dialect), "meta"))
    .filter((f) => !f.startsWith("_"))
    .sort();
}

export function readSnapshot(dialect: Dialect, file: string): Snapshot {
  return JSON.parse(fs.readFileSync(path.join(migrationsDir(dialect), "meta", file), "utf8"));
}

/**
 * Snapshot contents without its identity, key order ignored — what drizzle-kit
 * diffs. `_meta` is left out: it only records renames answered at generate
 * time (the CLI and the API even initialise it with different empty keys).
 */
export function snapshotContents(snapshot: Record<string, unknown>): string {
  const { id: _id, prevId: _prevId, _meta: _renames, ...rest } = snapshot;
  return JSON.stringify(sortKeys(rest));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

function runDrizzleKit(args: string[], cwd: string, env: Record<string, string> = {}): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [DRIZZLE_KIT, ...args], {
    cwd,
    env: { ...process.env, ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
    // No TTY: a rename prompt fails the run instead of waiting for input.
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function listFiles(dir: string, base = dir): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) for (const [k, v] of listFiles(full, base)) out.set(k, v);
    else out.set(path.relative(base, full).split(path.sep).join("/"), fs.readFileSync(full, "utf8"));
  }
  return out;
}

/**
 * Runs `drizzle-kit generate` for the real schema file against a temporary
 * copy of the committed migrations folder and reports every file it added or
 * changed. `prepare` may alter the copy first (used to prove drift is caught).
 * The checkout and the developer's database are never touched: generate does
 * not open a database, and its output goes to the copy.
 */
export function generateAgainstCopy(
  dialect: Dialect,
  prepare?: (copyDir: string) => void,
): { status: number | null; output: string; changed: string[] } {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `drizzle-metadata-${dialect}-`));
  try {
    const out = path.join(work, "migrations");
    fs.cpSync(migrationsDir(dialect), out, { recursive: true });
    prepare?.(out);
    const before = listFiles(out);
    const config = {
      // Absolute, forward slashes: drizzle-kit globs this path.
      schema: path.join(REPO, DIALECTS[dialect].schema).split(path.sep).join("/"),
      // Relative: drizzle-kit reads snapshots as `./<out>/meta/...` from its cwd.
      out: "./migrations",
      dialect,
      dbCredentials:
        dialect === "sqlite" ? { url: "./never-opened.db" } : { url: "postgres://unused@127.0.0.1:1/unused" },
    };
    fs.writeFileSync(path.join(work, "drizzle.config.ts"), `export default ${JSON.stringify(config)};\n`);
    const run = runDrizzleKit(["generate", "--config", "drizzle.config.ts"], work);
    const after = listFiles(out);
    const changed = [...after.keys()].filter((f) => before.get(f) !== after.get(f));
    return { ...run, changed };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Introspects a live database with `drizzle-kit pull` into a temporary folder
 * and returns the snapshot it produces. The connection string is passed to
 * the child process through the environment and never logged.
 */
export function pullSnapshot(dialect: Dialect, url: string): Snapshot {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `drizzle-pull-${dialect}-`));
  try {
    fs.writeFileSync(
      path.join(work, "drizzle.config.ts"),
      `export default { dialect: ${JSON.stringify(dialect)}, out: "./pulled", dbCredentials: { url: process.env.DRIZZLE_METADATA_PULL_URL } };\n`,
    );
    const run = runDrizzleKit(["pull", "--config", "drizzle.config.ts"], work, { DRIZZLE_METADATA_PULL_URL: url });
    const file = path.join(work, "pulled", "meta", "0000_snapshot.json");
    if (run.status !== 0 || !fs.existsSync(file)) {
      throw new Error(`drizzle-kit pull failed (exit ${run.status}):\n${run.output.split(url).join("<database url>")}`);
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Canonical SQL text for comparing an expression as the database reports it
 * with the same expression as the schema file writes it: no quoting or table
 * qualification, no `::text` casts, `= ANY (ARRAY[...])` as `in (...)`, `<>`
 * as `!=`, no parentheses, collapsed whitespace, lower case.
 */
function canonicalSql(value: string, table: string): string {
  return value
    .split(`"${table}".`)
    .join("")
    .replace(/"/g, "")
    .replace(/::text/g, "")
    .replace(/= ANY \(?ARRAY\[([^\]]*)\]\)?/g, "in ($1)")
    .replace(/<>/g, "!=")
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** SQLite stores booleans as integers; `DEFAULT false` and `DEFAULT 0` are the same default. */
function canonicalDefault(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (text === "false") return "0";
  if (text === "true") return "1";
  return text;
}

/**
 * What a database can actually be checked for — tables, columns (type,
 * nullability, primary key, default), indexes (columns, uniqueness, method,
 * predicate), foreign keys, composite primary keys, unique and check
 * constraints — with representational differences between introspection and
 * the schema serializer removed. Functions and triggers are not modelled by
 * Drizzle snapshots at all; the migration tests cover those.
 */
export function comparableStructure(snapshot: Snapshot): Record<string, unknown> {
  const tables: Record<string, unknown> = {};
  for (const [key, t] of Object.entries(snapshot.tables)) {
    tables[key] = {
      columns: Object.fromEntries(
        Object.entries(t.columns).map(([name, c]) => [
          name,
          {
            type: c.type.toLowerCase(),
            primaryKey: Boolean(c.primaryKey),
            notNull: Boolean(c.notNull),
            default: canonicalDefault(c.default),
          },
        ]),
      ),
      indexes: Object.fromEntries(
        Object.entries(t.indexes).map(([name, i]) => [
          name,
          {
            unique: Boolean(i.isUnique),
            method: i.method ?? null,
            where: i.where ? canonicalSql(i.where, t.name) : null,
            columns: i.columns.map((c) =>
              typeof c === "string"
                ? c
                : (() => {
                    const col = c as { expression: string; asc: boolean; nulls: string };
                    return `${canonicalSql(col.expression, t.name)} ${col.asc ? "asc" : "desc"} nulls ${col.nulls}`;
                  })(),
            ),
          },
        ]),
      ),
      foreignKeys: Object.fromEntries(
        Object.entries(t.foreignKeys).map(([name, f]) => [
          name,
          `(${f.columnsFrom.join(",")}) -> ${f.tableTo}(${f.columnsTo.join(",")}) on delete ${f.onDelete ?? "no action"} on update ${f.onUpdate ?? "no action"}`,
        ]),
      ),
      compositePrimaryKeys: Object.fromEntries(
        Object.entries(t.compositePrimaryKeys).map(([name, p]) => [name, p.columns.join(",")]),
      ),
      uniqueConstraints: Object.fromEntries(
        Object.entries(t.uniqueConstraints).map(([name, u]) => [name, u.columns.join(",")]),
      ),
      checkConstraints: Object.fromEntries(
        Object.entries(t.checkConstraints ?? {}).map(([name, c]) => [name, canonicalSql(c.value, t.name)]),
      ),
    };
  }
  return sortKeys(tables) as Record<string, unknown>;
}

/** Human-readable differences between two comparable structures (empty when equal). */
export function structureDifferences(actual: unknown, expected: unknown, at = ""): string[] {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return [];
  if (
    actual &&
    expected &&
    typeof actual === "object" &&
    typeof expected === "object" &&
    !Array.isArray(actual) &&
    !Array.isArray(expected)
  ) {
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(e)])].flatMap((k) => structureDifferences(a[k], e[k], `${at}.${k}`));
  }
  return [`${at}: database=${JSON.stringify(actual)} snapshot=${JSON.stringify(expected)}`];
}

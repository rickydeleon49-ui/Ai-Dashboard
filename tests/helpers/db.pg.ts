/**
 * A throwaway Postgres database per test file, mirroring helpers/db.ts's
 * SQLite pattern.
 *
 * DATABASE_URL must be set before anything imports the Postgres client or
 * schema, same reasoning as the SQLite helper: callers import this module
 * first and use its `migrate`/`cleanup` rather than importing application
 * modules at the top of the file.
 *
 * Needs a reachable Postgres server with a role that can create/drop
 * databases — TEST_DATABASE_ADMIN_URL points at it (defaults to the same
 * local role this repo's dev setup already uses). Tests that need this
 * belong under tests/unit-pg/, not tests/unit/, so they only run where that
 * server actually exists (see the `postgres` CI job).
 */
import crypto from "node:crypto";
import { Client } from "pg";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL?.trim() ||
  "postgres://ai_dashboard:ai_dashboard_dev@localhost:5432/postgres";

const dbName = `cc_test_${crypto.randomBytes(6).toString("hex")}`;

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${dbName}`;
process.env.DATABASE_URL = testUrl.toString();

/** Creates the throwaway database and applies migrations to it. */
export async function migrate(): Promise<void> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  const { runPgMigrations } = await import("../../src/db/migrate.pg");
  await runPgMigrations();
}

/** Closes the pool, then drops the throwaway database. */
export async function cleanup(): Promise<void> {
  const { closePgPool } = await import("../../src/db/pg-client");
  await closePgPool();

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } finally {
    await admin.end();
  }
}

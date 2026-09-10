/**
 * Applies pending Drizzle migrations to the Postgres database (hosted
 * multi-user mode). Run via `npm run db:migrate:pg`. Mirrors migrate.ts's
 * SQLite counterpart; not run automatically by `ensureDatabaseReady()` since
 * that path only ever runs for the SQLite/desktop/legacy-hosted database.
 */
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getPgDb, closePgPool } from "./pg-client";

export async function runPgMigrations(): Promise<void> {
  await migrate(getPgDb(), { migrationsFolder: path.resolve(process.cwd(), "drizzle-pg") });
}

// Allow `tsx src/db/migrate.pg.ts` as a standalone command.
if (process.argv[1] && process.argv[1].endsWith("migrate.pg.ts")) {
  runPgMigrations()
    .then(async () => {
      console.log("Postgres migrations applied.");
      await closePgPool();
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

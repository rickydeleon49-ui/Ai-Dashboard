/**
 * Applies pending Drizzle migrations. Run via `npm run db:migrate`, and
 * automatically on server boot by `ensureDatabaseReady()`.
 */
import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db } from "./client";

export function runMigrations(): void {
  migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

// Allow `tsx src/db/migrate.ts` as a standalone command.
if (process.argv[1] && process.argv[1].endsWith("migrate.ts")) {
  runMigrations();
  console.log("Migrations applied.");
}

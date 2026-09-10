import type { Config } from "drizzle-kit";
import { resolveDatabaseUrl } from "./src/db/path";

const url = resolveDatabaseUrl();
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. drizzle-kit's Postgres commands (db:generate:pg, " +
      "db:migrate:pg) need a Postgres connection string — set DATABASE_URL " +
      "before running them. Desktop and today's single-password hosted mode " +
      "never need this.",
  );
}

export default {
  schema: "./src/db/schema.pg.ts",
  out: "./drizzle-pg",
  dialect: "postgresql",
  dbCredentials: { url },
} satisfies Config;

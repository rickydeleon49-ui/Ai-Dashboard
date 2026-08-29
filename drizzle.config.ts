import type { Config } from "drizzle-kit";
import { resolveDatabasePath } from "./src/db/path";

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: { url: resolveDatabasePath() },
} satisfies Config;

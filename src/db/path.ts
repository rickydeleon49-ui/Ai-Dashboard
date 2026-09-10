/**
 * Resolves filesystem locations for persistent state.
 *
 * Both are environment-driven so that a Railway deployment can point them at a
 * mounted volume (e.g. DATABASE_PATH=/data/dashboard.db) without code changes.
 */
import path from "node:path";

export function resolveDatabasePath(): string {
  const configured = process.env.DATABASE_PATH?.trim();
  if (configured) return path.resolve(configured);
  return path.resolve(process.cwd(), "data", "dashboard.db");
}

export function resolveUploadsDir(): string {
  const configured = process.env.UPLOADS_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.resolve(process.cwd(), "data", "uploads");
}

/**
 * The Postgres connection string for hosted multi-user mode, or null.
 *
 * Unlike `resolveDatabasePath`, there is no sensible local-file default here —
 * absence means "not running in hosted multi-user mode" rather than "use a
 * default database." Desktop and today's single-password hosted mode never
 * read this at all.
 */
export function resolveDatabaseUrl(): string | null {
  const configured = process.env.DATABASE_URL?.trim();
  return configured ? configured : null;
}

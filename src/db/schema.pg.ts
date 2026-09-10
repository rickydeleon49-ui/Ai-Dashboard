/**
 * Database schema (PostgreSQL via Drizzle) — hosted multi-user mode only.
 *
 * Separate from `schema.ts` (SQLite) deliberately: Drizzle's `sqlite-core` and
 * `pg-core` table builders are not interchangeable, so there is no way to share
 * table definitions between the two dialects. Desktop and today's single-
 * password hosted mode never read this file or connect to Postgres at all —
 * this schema only exists once `DATABASE_URL` is configured.
 *
 * Filled in incrementally: this file starts empty (Postgres plumbing, no
 * behavior change) and gains the Auth.js adapter tables, then the workspace
 * domain, in the PRs that follow.
 */
export {};

/** Postgres SQLSTATE for a unique-constraint violation. */
export const UNIQUE_VIOLATION = "23505";

/**
 * The real Postgres error's SQLSTATE code, if `error` is (or wraps) one.
 *
 * Drizzle wraps the actual `pg` error inside `DrizzleQueryError`, whose own
 * `.code` is undefined — the original error, with the `code` that actually
 * matters, is on `.cause` instead (confirmed the hard way once already: see
 * core/workspaces/service.ts's isLastOwnerViolation, which walks the same
 * chain for the same reason). Walking `.cause` here means every caller gets
 * this right automatically instead of re-discovering it.
 */
export function pgErrorCode(error: unknown): string | undefined {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if ("code" in current && typeof current.code === "string") return current.code;
  }
  return undefined;
}

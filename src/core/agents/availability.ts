/**
 * Desktop-only availability gate for the Agent Workflow Control Center.
 *
 * §2.2: A server that launches CLI processes against filesystem paths amounts to
 * remote code execution if reachable by anyone else. Agent features must remain
 * strictly disabled unless running in local Electron desktop mode bound to loopback.
 */

/**
 * Hosted multi-user accounts mode (Auth.js + PostgreSQL).
 *
 * Parameterized mirror of isAccountsMode() from src/lib/auth-mode.ts.
 */
export function isAccountsModeEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return env.AUTH_MODE === "accounts" && Boolean(env.DATABASE_URL?.trim());
}

/**
 * Hosted single-password mode.
 *
 * Parameterized mirror of isPasswordMode() from src/lib/auth-mode.ts.
 */
export function isPasswordModeEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return env.AUTH_MODE !== "accounts" && Boolean(env.DASHBOARD_PASSWORD?.trim());
}

/**
 * Desktop mode check parameterized by environment.
 *
 * Parameterized mirror of isDesktopMode() from src/lib/auth-mode.ts.
 */
export function isDesktopModeEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return !isAccountsModeEnv(env) && !isPasswordModeEnv(env);
}

/**
 * Determines whether agent runs are enabled in the current environment.
 *
 * True ONLY when all of the following hold:
 * - env.DASHBOARD_LOCAL === "1"
 * - env.DESKTOP_INTERNAL_SECRET is a non-empty, non-whitespace string
 * - Not in accounts mode (AUTH_MODE !== "accounts")
 * - Not in password mode (DASHBOARD_PASSWORD is not set)
 * - No DATABASE_URL is configured (SQLite only)
 *
 * Fails closed on any doubt or missing requirement (§2.2).
 */
export function isAgentRunsEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  if (env.DASHBOARD_LOCAL !== "1") {
    return false;
  }

  const secret = env.DESKTOP_INTERNAL_SECRET;
  if (typeof secret !== "string" || secret.trim().length === 0) {
    return false;
  }

  if (env.AUTH_MODE === "accounts" || isAccountsModeEnv(env)) {
    return false;
  }

  if (isPasswordModeEnv(env) || Boolean(env.DASHBOARD_PASSWORD?.trim())) {
    return false;
  }

  if (Boolean(env.DATABASE_URL?.trim())) {
    return false;
  }

  if (!isDesktopModeEnv(env)) {
    return false;
  }

  return true;
}

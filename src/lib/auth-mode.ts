/**
 * Centralized authentication and deployment mode detection.
 *
 * Prevents drift across proxy, API routes, layout, schedulers, and desktop shell.
 */

export type AuthMode = "accounts" | "password" | "desktop" | "self-hosted";

/** Self-hosted mode (AW.5): only when AGENT_HOST_MODE is exactly "self-hosted". */
export function isSelfHostedMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.AGENT_HOST_MODE === "self-hosted";
}

/**
 * Hosted multi-user accounts mode (Auth.js + PostgreSQL).
 *
 * Requires both AUTH_MODE=accounts and a configured DATABASE_URL.
 */
export function isAccountsMode(): boolean {
  return process.env.AUTH_MODE === "accounts" && Boolean(process.env.DATABASE_URL);
}

/**
 * Hosted single-password mode.
 *
 * Active when not in accounts mode and DASHBOARD_PASSWORD is configured.
 */
export function isPasswordMode(): boolean {
  return process.env.AUTH_MODE !== "accounts" && Boolean(process.env.DASHBOARD_PASSWORD?.trim());
}

/**
 * Local Desktop mode (Electron single-tenant SQLite).
 *
 * Active when not in accounts mode, no DATABASE_URL is set, and no DASHBOARD_PASSWORD is set.
 */
export function isDesktopMode(): boolean {
  return !isSelfHostedMode() && !isAccountsMode() && !isPasswordMode();
}

export function getAuthMode(): AuthMode {
  if (isSelfHostedMode()) return "self-hosted";
  if (isAccountsMode()) return "accounts";
  if (isPasswordMode()) return "password";
  return "desktop";
}

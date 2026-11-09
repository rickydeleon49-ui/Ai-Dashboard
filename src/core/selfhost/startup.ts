/**
 * Pure start-up configuration validation. Takes the environment as a
 * parameter so it can be tested without touching process.env.
 */

import { validateBindAddress } from "./bind";

export type StartupCheck = { valid: boolean; error?: string };

const fail = (error: string): StartupCheck => ({ valid: false, error });

export function validateStartupConfig(
  env: Record<string, string | undefined> = process.env,
): StartupCheck {
  if (env.AGENT_HOST_MODE !== undefined) {
    if (env.AGENT_HOST_MODE !== "self-hosted") {
      return fail('AGENT_HOST_MODE must be exactly "self-hosted" when set.');
    }
    if (env.AUTH_MODE === "accounts") {
      return fail("Self-hosted mode cannot be used with AUTH_MODE=accounts.");
    }
    if (env.DATABASE_URL) {
      return fail("Self-hosted mode cannot be used with DATABASE_URL.");
    }
    if (env.DASHBOARD_PASSWORD) {
      return fail("Self-hosted mode cannot be used with DASHBOARD_PASSWORD.");
    }
    const railway = Object.keys(env).find((k) => k.startsWith("RAILWAY_"));
    if (railway) {
      return fail(
        `Self-hosted mode cannot run on Railway (${railway} is set).`,
      );
    }
    if (env.DASHBOARD_LOCAL === "1") {
      return fail("Self-hosted mode cannot be used with DASHBOARD_LOCAL=1.");
    }
    if (env.DESKTOP_INTERNAL_SECRET) {
      return fail(
        "Self-hosted mode cannot be used with DESKTOP_INTERNAL_SECRET.",
      );
    }
    const host = env.HOSTNAME?.trim();
    if (!host) {
      return fail(
        "Self-hosted mode needs HOSTNAME set to the address to bind to, for example HOSTNAME=127.0.0.1.",
      );
    }
    const bind = validateBindAddress(host, {
      allowLan: env.AGENT_HOST_ALLOW_LAN === "1",
    });
    if (!bind.ok) return fail(bind.error);
    return { valid: true };
  }

  if (env.DASHBOARD_LOCAL === "1" || env.DESKTOP_INTERNAL_SECRET) {
    if (env.AUTH_MODE === "accounts" || Boolean(env.DATABASE_URL)) {
      return fail(
        "Desktop local mode cannot be used with AUTH_MODE=accounts or DATABASE_URL.",
      );
    }
    if (Boolean(env.DASHBOARD_PASSWORD?.trim())) {
      return fail("Desktop local mode cannot be used with DASHBOARD_PASSWORD.");
    }
  }
  return { valid: true };
}

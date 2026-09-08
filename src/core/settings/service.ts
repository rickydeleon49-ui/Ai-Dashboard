import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { settings } from "@/db/schema";

/**
 * Key/value store for configuration the user sets from inside the application.
 *
 * Environment variables are the right place for deployment configuration, but
 * the desktop app has no terminal in front of it — asking someone to set a
 * variable and restart is not a setting, it is a chore. Anything a user should
 * be able to change while the app is running belongs here.
 */

/** Namespaced so future integrations do not collide. */
export const SETTING_KEYS = {
  githubToken: "github.token",
  /** How the stored token was obtained: "oauth" or "pat". */
  githubTokenOrigin: "github.token_origin",
  /** OAuth app client id enabling "Connect with GitHub". Not a secret. */
  githubClientId: "github.client_id",

  /*
   * Local AI. One row per preference rather than a single JSON blob: a blob
   * cannot be updated by one form field without a read-modify-write race, and
   * it hides what is actually stored from anyone opening the database.
   */
  aiEnabled: "ai.enabled",
  aiAutoStart: "ai.auto_start",
  aiProvider: "ai.provider",
  aiEndpoint: "ai.endpoint",
  aiDefaultModel: "ai.default_model",
  aiPreloadModel: "ai.preload_model",
  aiIdleTimeoutMinutes: "ai.idle_timeout_minutes",
  aiContextSize: "ai.context_size",
  aiStreaming: "ai.streaming",
  aiReasoningEffort: "ai.reasoning_effort",
  aiMode: "ai.mode",
  aiAgentEnabled: "ai.agent_enabled",
  /** Path to the Hermes executable. Never passed to a shell. */
  aiHermesPath: "ai.hermes_path",
  aiLastProjectId: "ai.last_project_id",
} as const;

/**
 * Agent approval policies are one row per action (`ai.approval.run_command`),
 * for the same reason as the preferences above: a single JSON blob cannot be
 * updated one field at a time without a read-modify-write race, and it hides
 * what is stored from anyone opening the database.
 */
export type ApprovalSettingKey = `ai.approval.${string}`;

export function approvalKey(action: string): ApprovalSettingKey {
  return `ai.approval.${action}`;
}

export type SettingKey =
  | (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS]
  | ApprovalSettingKey;

export function getSetting(key: SettingKey): string | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  const value = row?.value?.trim();
  return value ? value : null;
}

export function setSetting(key: SettingKey, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    deleteSetting(key);
    return;
  }

  db.insert(settings)
    .values({ key, value: trimmed, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: trimmed, updatedAt: new Date().toISOString() },
    })
    .run();
}

export function deleteSetting(key: SettingKey): void {
  db.delete(settings).where(eq(settings.key, key)).run();
}

/**
 * A safe description of a stored secret.
 *
 * Secrets are never sent back to the browser — only enough to confirm which one
 * is stored. A page that echoed the token would put it in the DOM, in the
 * server-rendered payload, and in any screenshot of the settings screen.
 */
export interface SecretStatus {
  present: boolean;
  /** Last four characters, e.g. "…YufJ". Null when nothing is stored. */
  hint: string | null;
}

export function describeSecret(key: SettingKey): SecretStatus {
  const value = getSetting(key);
  if (!value) return { present: false, hint: null };
  return { present: true, hint: value.slice(-4) };
}

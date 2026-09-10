import "server-only";

import crypto from "node:crypto";
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

/**
 * Encrypted at rest when a key is available. `githubClientId` is documented
 * as not a secret, and `githubTokenOrigin` is just "oauth" | "pat" — only the
 * token itself needs this.
 */
const SECRET_KEYS = new Set<SettingKey>([SETTING_KEYS.githubToken]);

/**
 * Set by the desktop main process (`desktop/main.js`'s `resolveEncryptionKey`)
 * and handed to this forked server once via env, the same way DATABASE_PATH
 * is. Absent in hosted/web mode (no Electron, no OS keychain to protect a key
 * with) and in `desktop:dev` (the server there is started before Electron
 * exists to inject anything) — both fall back to the plaintext this module
 * always used before encryption existed.
 */
const ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY
  ? Buffer.from(process.env.SETTINGS_ENCRYPTION_KEY, "base64")
  : null;

const ENC_PREFIX = "enc:v1:";

/** AES-256-GCM: the auth tag makes a wrong or missing key fail loudly on read, rather than returning garbage as if it were the real secret. */
function encryptSecret(plain: string): string {
  if (!ENCRYPTION_KEY) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ENC_PREFIX + Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64");
}

function decryptSecret(envelope: string): string | null {
  if (!ENCRYPTION_KEY) return null;
  try {
    const raw = Buffer.from(envelope.slice(ENC_PREFIX.length), "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ciphertext = raw.subarray(12, raw.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key, no key, or a corrupted row — none of these is recoverable
    // here, so this is treated as "nothing stored" rather than thrown.
    return null;
  }
}

export function getSetting(key: SettingKey): string | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  const value = row?.value?.trim();
  if (!value) return null;
  if (!SECRET_KEYS.has(key)) return value;

  if (value.startsWith(ENC_PREFIX)) return decryptSecret(value);

  // A plaintext secret written before this module encrypted anything.
  // Upgraded in place on first read, so an existing token is protected from
  // here on without the user having to re-enter it.
  if (ENCRYPTION_KEY) setSetting(key, value);
  return value;
}

export function setSetting(key: SettingKey, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    deleteSetting(key);
    return;
  }

  const stored = SECRET_KEYS.has(key) ? encryptSecret(trimmed) : trimmed;

  db.insert(settings)
    .values({ key, value: stored, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: stored, updatedAt: new Date().toISOString() },
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

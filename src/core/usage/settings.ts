/**
 * Where the usage trackers' CSV files live (desktop setting, per machine).
 *
 * Stored in the settings table under `usage.folder`. The store is injectable
 * and the default is loaded lazily, as in src/core/agents/roots.ts, so
 * importing this module never opens the application database.
 */
import nodePath from "node:path";
import { isSafeAbsolute } from "@/core/agents/resolve-executable";

export const DEFAULT_USAGE_FOLDER = "G:/My Drive/Claude Usage";
const KEY_USAGE_FOLDER = "usage.folder";

export interface UsageSettingsStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

async function defaultStore(): Promise<UsageSettingsStore> {
  const svc = await import("@/core/settings/service");
  return {
    get: (k) => svc.getSetting(k as never),
    set: (k, v) => svc.setSetting(k as never, v),
  };
}

export async function getUsageFolder(
  store?: UsageSettingsStore,
): Promise<string> {
  const s = store ?? (await defaultStore());
  const v = s.get(KEY_USAGE_FOLDER)?.trim();
  return v ? v : DEFAULT_USAGE_FOLDER;
}

export type SetUsageFolderResult = { ok: true } | { ok: false; reason: string };

export async function setUsageFolder(
  folder: string,
  opts: { store?: UsageSettingsStore; platform?: NodeJS.Platform } = {},
): Promise<SetUsageFolderResult> {
  const platform = opts.platform ?? process.platform;
  const trimmed = typeof folder === "string" ? folder.trim() : "";
  if (trimmed === "") return { ok: false, reason: "Folder must not be empty." };
  if (trimmed.includes("\0")) {
    return { ok: false, reason: "Folder contains an invalid character." };
  }
  if (!isSafeAbsolute(trimmed, platform)) {
    return { ok: false, reason: "Folder must be an absolute path." };
  }
  const store = opts.store ?? (await defaultStore());
  store.set(KEY_USAGE_FOLDER, nodePath.normalize(trimmed));
  return { ok: true };
}

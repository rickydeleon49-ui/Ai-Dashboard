import "server-only";

import {
  deleteSetting,
  getSetting,
  setSetting,
  SETTING_KEYS,
  type SettingKey,
} from "@/core/settings/service";
import {
  AI_DEFAULTS,
  aiSettingsSchema,
  type AiSettings,
  type AiSettingsUpdate,
} from "./config";

/**
 * Local AI preferences, on top of the application's existing key/value store.
 *
 * No new table and no new database: these are user preferences, which is
 * exactly what `settings` is for. The store holds strings, so the typed shape
 * is reassembled here and validated on the way out — a value edited by hand in
 * the database cannot produce a `contextSize` of `"banana"` anywhere upstream.
 */

const KEYS: Record<keyof AiSettings, SettingKey> = {
  enabled: SETTING_KEYS.aiEnabled,
  autoStart: SETTING_KEYS.aiAutoStart,
  provider: SETTING_KEYS.aiProvider,
  endpoint: SETTING_KEYS.aiEndpoint,
  defaultModel: SETTING_KEYS.aiDefaultModel,
  preloadModel: SETTING_KEYS.aiPreloadModel,
  idleTimeoutMinutes: SETTING_KEYS.aiIdleTimeoutMinutes,
  contextSize: SETTING_KEYS.aiContextSize,
  streaming: SETTING_KEYS.aiStreaming,
  reasoningEffort: SETTING_KEYS.aiReasoningEffort,
  mode: SETTING_KEYS.aiMode,
  agentEnabled: SETTING_KEYS.aiAgentEnabled,
  hermesPath: SETTING_KEYS.aiHermesPath,
  lastProjectId: SETTING_KEYS.aiLastProjectId,
};

function readBoolean(key: SettingKey, fallback: boolean): boolean {
  const raw = getSetting(key);
  if (raw === null) return fallback;
  return raw === "true" || raw === "1";
}

function readNumber(key: SettingKey, fallback: number): number {
  const raw = getSetting(key);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getAiSettings(): AiSettings {
  const candidate = {
    enabled: readBoolean(KEYS.enabled, AI_DEFAULTS.enabled),
    autoStart: readBoolean(KEYS.autoStart, AI_DEFAULTS.autoStart),
    provider: getSetting(KEYS.provider) ?? AI_DEFAULTS.provider,
    endpoint: getSetting(KEYS.endpoint) ?? AI_DEFAULTS.endpoint,
    defaultModel: getSetting(KEYS.defaultModel) ?? AI_DEFAULTS.defaultModel,
    preloadModel: readBoolean(KEYS.preloadModel, AI_DEFAULTS.preloadModel),
    idleTimeoutMinutes: readNumber(KEYS.idleTimeoutMinutes, AI_DEFAULTS.idleTimeoutMinutes),
    contextSize: readNumber(KEYS.contextSize, AI_DEFAULTS.contextSize),
    streaming: readBoolean(KEYS.streaming, AI_DEFAULTS.streaming),
    reasoningEffort: getSetting(KEYS.reasoningEffort) ?? AI_DEFAULTS.reasoningEffort,
    mode: getSetting(KEYS.mode) ?? AI_DEFAULTS.mode,
    agentEnabled: readBoolean(KEYS.agentEnabled, AI_DEFAULTS.agentEnabled),
    hermesPath: getSetting(KEYS.hermesPath) ?? AI_DEFAULTS.hermesPath,
    lastProjectId: getSetting(KEYS.lastProjectId) ?? AI_DEFAULTS.lastProjectId,
  };

  // A stored value that no longer parses (an old enum member, a hand edit)
  // falls back to the default for that one field rather than throwing.
  const parsed = aiSettingsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : AI_DEFAULTS;
}

/** Applies a validated partial update and returns the settings as they now are. */
export function updateAiSettings(update: AiSettingsUpdate): AiSettings {
  for (const [field, value] of Object.entries(update) as [keyof AiSettings, unknown][]) {
    const key = KEYS[field];
    if (!key) continue;

    if (typeof value === "boolean") {
      setSetting(key, value ? "true" : "false");
    } else if (typeof value === "number") {
      setSetting(key, String(value));
    } else if (typeof value === "string") {
      // The store treats an empty string as "forget this", which is the right
      // meaning here: an empty default model means "use the first installed".
      if (value) setSetting(key, value);
      else deleteSetting(key);
    }
  }

  return getAiSettings();
}

/** Remembers which project the workspace was last pointed at. */
export function rememberLastProject(projectId: string | null): void {
  if (projectId) setSetting(KEYS.lastProjectId, projectId);
  else deleteSetting(KEYS.lastProjectId);
}

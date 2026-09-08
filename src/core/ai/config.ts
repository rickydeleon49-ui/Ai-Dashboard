/**
 * Local AI preferences: their shape, their defaults and their validation.
 *
 * Deliberately free of database and Node imports so a client component can
 * import the type and the defaults without dragging the server in. Reading and
 * writing lives in `./settings.ts`, which is server-only.
 *
 * Defaults are chosen for a 16 GB card: nothing is loaded until the user asks,
 * and an idle model gives its memory back.
 */
import { z } from "zod";
import { AI_MODES, AI_PROVIDERS } from "./types";
import { DEFAULT_OLLAMA_ENDPOINT } from "./ollama-client";

/**
 * Reasoning effort, passed through only when the model advertises support.
 *
 * "default" means send nothing at all — the model's own behaviour — rather than
 * a value this application invented.
 */
export const AI_REASONING_EFFORTS = ["default", "low", "medium", "high"] as const;
export type AiReasoningEffort = (typeof AI_REASONING_EFFORTS)[number];

export interface AiSettings {
  /** Master switch. Off means the workspace shows the feature as disabled. */
  enabled: boolean;
  /** Start Ollama with Command Center if it is not already running. */
  autoStart: boolean;
  /** Which provider the workspace opens with. */
  provider: (typeof AI_PROVIDERS)[number];
  /** Ollama API base URL. */
  endpoint: string;
  /** Tag of the model to select by default. Empty means "first installed". */
  defaultModel: string;
  /** Load the default model into VRAM at startup instead of on first use. */
  preloadModel: boolean;
  /** Minutes of inactivity after which Ollama unloads the model. 0 = never. */
  idleTimeoutMinutes: number;
  /** num_ctx for new conversations. */
  contextSize: number;
  /** Stream tokens as they arrive. */
  streaming: boolean;
  reasoningEffort: AiReasoningEffort;
  /** Chat or Agent, remembered between sessions. */
  mode: (typeof AI_MODES)[number];
  /** Whether Agent mode is offered at all. */
  agentEnabled: boolean;
  /** Absolute path to the Hermes executable. Empty means "look on PATH". */
  hermesPath: string;
  /** Last project opened in the workspace, so it reopens where you left off. */
  lastProjectId: string;
}

export const AI_DEFAULTS: AiSettings = {
  enabled: true,
  autoStart: true,
  provider: "local",
  endpoint: DEFAULT_OLLAMA_ENDPOINT,
  defaultModel: "",
  // A large model is 11 GB of VRAM. Paying that at every launch, for a session
  // that may never open the workspace, is the wrong default.
  preloadModel: false,
  idleTimeoutMinutes: 10,
  contextSize: 8192,
  streaming: true,
  reasoningEffort: "default",
  mode: "chat",
  agentEnabled: false,
  hermesPath: "",
  lastProjectId: "",
};

/** Context sizes offered in the interface. Larger costs VRAM, linearly. */
export const CONTEXT_SIZES = [4096, 8192, 16384, 32768, 40960, 65536, 131072] as const;

/**
 * Accepts a partial, possibly hand-edited settings object.
 *
 * Every field falls back to its default rather than failing the whole update:
 * these are read on every page load, and one bad row should not take the
 * workspace down with it.
 */
export const aiSettingsSchema = z.object({
  enabled: z.boolean().default(AI_DEFAULTS.enabled),
  autoStart: z.boolean().default(AI_DEFAULTS.autoStart),
  provider: z.enum(AI_PROVIDERS).default(AI_DEFAULTS.provider),
  endpoint: z
    .string()
    .trim()
    .max(200)
    .refine(
      (value) => {
        if (!value) return true;
        try {
          const url = new URL(value);
          return url.protocol === "http:" || url.protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "Enter a full URL, for example http://127.0.0.1:11434" },
    )
    .default(AI_DEFAULTS.endpoint),
  // A tag, not a path: it is sent to Ollama, never to a shell or a filesystem.
  defaultModel: z.string().trim().max(200).default(AI_DEFAULTS.defaultModel),
  preloadModel: z.boolean().default(AI_DEFAULTS.preloadModel),
  idleTimeoutMinutes: z.number().int().min(0).max(1440).default(AI_DEFAULTS.idleTimeoutMinutes),
  contextSize: z.number().int().min(512).max(1_048_576).default(AI_DEFAULTS.contextSize),
  streaming: z.boolean().default(AI_DEFAULTS.streaming),
  reasoningEffort: z.enum(AI_REASONING_EFFORTS).default(AI_DEFAULTS.reasoningEffort),
  mode: z.enum(AI_MODES).default(AI_DEFAULTS.mode),
  agentEnabled: z.boolean().default(AI_DEFAULTS.agentEnabled),
  hermesPath: z.string().trim().max(500).default(AI_DEFAULTS.hermesPath),
  lastProjectId: z.string().trim().max(64).default(AI_DEFAULTS.lastProjectId),
});

/** The subset a settings form may change. Everything is optional. */
export const aiSettingsUpdateSchema = aiSettingsSchema.partial();
export type AiSettingsUpdate = z.infer<typeof aiSettingsUpdateSchema>;

/**
 * Ollama's `keep_alive`, derived from the idle timeout.
 *
 * This is the whole of "auto-unload after idle": Ollama already evicts a model
 * that has not been used for `keep_alive`, so a timer of our own would be a
 * second, competing answer to the same question.
 */
export function keepAliveFor(settings: Pick<AiSettings, "idleTimeoutMinutes">): string | null {
  if (settings.idleTimeoutMinutes <= 0) return "-1"; // Ollama: keep indefinitely.
  return `${settings.idleTimeoutMinutes}m`;
}

/** The value to send as `think`, or null to send nothing. */
export function reasoningFor(settings: Pick<AiSettings, "reasoningEffort">): string | null {
  return settings.reasoningEffort === "default" ? null : settings.reasoningEffort;
}

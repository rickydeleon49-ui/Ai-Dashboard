/**
 * The vocabulary of the local AI system.
 *
 * Everything above this file — routes, components, the desktop shell — talks in
 * these types and never in Ollama's wire format. That is what makes a second
 * provider (Hermes, or anything else) an additional implementation rather than
 * a rewrite of the workspace.
 */

/** Which implementation is answering. */
export const AI_PROVIDERS = ["local", "hermes"] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

/** What the user is trying to do. Chat talks; Agent acts. */
export const AI_MODES = ["chat", "agent"] as const;
export type AiMode = (typeof AI_MODES)[number];

/**
 * Connection state, in the order a healthy startup moves through them.
 *
 *   unsupported   this build cannot reach a local machine at all (hosted web)
 *   disabled      the user turned local AI off
 *   offline       nothing is listening on the endpoint
 *   starting      a launch is in flight
 *   ready         the API answered
 *   loading_model a request is waiting for weights to reach VRAM
 *   generating    tokens are streaming
 *   error         something failed in a way the user should see
 */
export const AI_STATES = [
  "unsupported",
  "disabled",
  "offline",
  "starting",
  "ready",
  "loading_model",
  "generating",
  "error",
] as const;
export type AiState = (typeof AI_STATES)[number];

/** A model Ollama reports as installed. */
export interface LocalModel {
  /** The tag used to address it, e.g. "qwen3:8b". */
  name: string;
  /** Bytes on disk. 0 when Ollama did not say. */
  size: number;
  /** e.g. "8.0B". Null when unknown — never guessed. */
  parameterSize: string | null;
  /** e.g. "Q4_K_M". */
  quantization: string | null;
  family: string | null;
  modifiedAt: string | null;
}

/** A model Ollama reports as currently resident. */
export interface LoadedModel {
  name: string;
  /** Bytes reported as held in VRAM. 0 when Ollama did not say. */
  sizeVram: number;
  /** When Ollama will unload it, if it said. */
  expiresAt: string | null;
}

export interface ProviderStatus {
  provider: AiProviderId;
  state: AiState;
  /** One short sentence for the UI. Never a stack trace. */
  detail: string;
  /** Where this provider was looked for. */
  endpoint: string | null;
  /** Technical detail for the diagnostics panel and the log. */
  error: string | null;
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** num_ctx. Ollama's own default is used when null. */
  contextSize: number | null;
  /** Ollama keep_alive, e.g. "10m" or "0" to unload immediately after. */
  keepAlive: string | null;
  /** Passed through only for models that advertise support. */
  reasoningEffort: string | null;
  signal?: AbortSignal;
}

/** One event in a generation. Streaming and non-streaming both produce these. */
export type ChatEvent =
  | { type: "start"; model: string }
  | { type: "delta"; text: string }
  | { type: "done"; text: string; promptTokens: number | null; completionTokens: number | null; durationMs: number }
  | { type: "error"; code: AiErrorCode; message: string };

/**
 * Every way a request can fail, as a closed set.
 *
 * The UI maps these to sentences a person can act on. A code that does not
 * exist here would fall through to a generic message, so failures are
 * classified here at the boundary rather than by matching strings in a
 * component.
 */
export const AI_ERROR_CODES = [
  "not_configured",
  "offline",
  "start_failed",
  "model_missing",
  "loading",
  "timeout",
  "cancelled",
  "malformed",
  "out_of_memory",
  "generation_failed",
  "unsupported",
] as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

/** An error carrying a code the interface can render without guessing. */
export class AiError extends Error {
  readonly code: AiErrorCode;
  /** Detail for logs and the diagnostics panel; not for the chat surface. */
  readonly detail: string | null;

  constructor(code: AiErrorCode, message: string, detail?: string | null) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.detail = detail ?? null;
  }
}

export function isAiError(value: unknown): value is AiError {
  return value instanceof AiError;
}

/**
 * What every provider must offer.
 *
 * Deliberately small. A provider answers three questions — are you there, what
 * can you run, and please generate — and everything project-, settings- and
 * persistence-shaped stays above it.
 */
export interface AIProvider {
  readonly id: AiProviderId;
  readonly label: string;
  status(): Promise<ProviderStatus>;
  listModels(): Promise<LocalModel[]>;
  /** Loaded/resident models, when the provider can report them. */
  listLoaded?(): Promise<LoadedModel[]>;
  chat(request: ChatRequest): AsyncGenerator<ChatEvent, void, void>;
}

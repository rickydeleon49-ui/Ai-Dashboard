/**
 * A typed client for one Ollama instance.
 *
 * Nothing here reads settings, touches the database or knows about projects —
 * it is the HTTP boundary and only that, with `fetch` injectable so the whole
 * surface can be tested without a server or a model on disk.
 *
 * The native API is used rather than the OpenAI-compatible one: `keep_alive`
 * (which is how a model is unloaded after idling), `options.num_ctx` and
 * `/api/ps` have no equivalent under `/v1`, and those three are exactly the
 * controls a 16 GB card needs.
 */
import {
  AiError,
  type ChatEvent,
  type ChatRequest,
  type LoadedModel,
  type LocalModel,
} from "./types";
import { createNdjsonParser, NdjsonParseError } from "./ndjson";

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export interface OllamaClientOptions {
  endpoint: string;
  fetchImpl?: FetchLike;
  /** Ceiling for the small request/response calls (tags, ps, preload). */
  requestTimeoutMs?: number;
  /**
   * How long a generation may take to produce its *first* chunk.
   *
   * Generous on purpose: this is the window in which an 11 GB model is being
   * read off disk into VRAM, which on a cold cache is minutes, not seconds.
   */
  firstChunkTimeoutMs?: number;
  /** How long a generation may stall *after* it has started producing. */
  idleTimeoutMs?: number;
}

/** The default place Ollama listens. */
export const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434";

/** Strips a trailing slash so paths can be concatenated without doubling it. */
export function normaliseEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "") || DEFAULT_OLLAMA_ENDPOINT;
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Turns `/api/tags` into the model list.
 *
 * Tolerant by design: a future Ollama that adds or drops a detail field should
 * change what is *displayed*, never whether the selector works at all. Anything
 * without a name is dropped, because a model that cannot be addressed is not a
 * choice the user can make.
 */
export function parseModels(payload: unknown): LocalModel[] {
  const root = asRecord(payload);
  const raw = root?.models;
  if (!Array.isArray(raw)) return [];

  const models: LocalModel[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const name = asString(record?.name) ?? asString(record?.model);
    if (!name) continue;

    const details = asRecord(record?.details);
    models.push({
      name,
      size: asNumber(record?.size),
      parameterSize: asString(details?.parameter_size),
      quantization: asString(details?.quantization_level),
      family: asString(details?.family),
      modifiedAt: asString(record?.modified_at),
    });
  }

  // Alphabetical: Ollama's own order is by modification time, which reshuffles
  // the selector whenever a model is touched.
  return models.sort((a, b) => a.name.localeCompare(b.name));
}

/** Turns `/api/ps` into the resident-model list. */
export function parseLoaded(payload: unknown): LoadedModel[] {
  const root = asRecord(payload);
  const raw = root?.models;
  if (!Array.isArray(raw)) return [];

  const loaded: LoadedModel[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const name = asString(record?.name) ?? asString(record?.model);
    if (!name) continue;
    loaded.push({
      name,
      sizeVram: asNumber(record?.size_vram),
      expiresAt: asString(record?.expires_at),
    });
  }
  return loaded;
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * Maps anything thrown by fetch, or any error body Ollama returns, onto a code.
 *
 * Done once, here, so no component ever matches on an error string.
 */
export function classifyError(error: unknown, context: "request" | "stream"): AiError {
  if (error instanceof AiError) return error;

  if (error instanceof NdjsonParseError) {
    return new AiError("malformed", error.message, error.line);
  }

  const name = error instanceof Error ? error.name : "";
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw.toLowerCase();

  if (name === "AbortError" || text.includes("aborted")) {
    return new AiError("cancelled", "Generation stopped.", raw);
  }
  if (
    text.includes("econnrefused") ||
    text.includes("fetch failed") ||
    text.includes("connect") ||
    text.includes("network")
  ) {
    return new AiError(
      "offline",
      "Ollama is not responding on this machine.",
      raw,
    );
  }
  if (text.includes("timeout") || text.includes("timed out")) {
    return new AiError("timeout", "The AI service took too long to respond.", raw);
  }

  return new AiError(
    context === "stream" ? "generation_failed" : "offline",
    context === "stream"
      ? "The model stopped before it finished answering."
      : "Could not reach the AI service.",
    raw,
  );
}

/** Classifies a non-2xx response body from Ollama. */
function classifyResponse(status: number, body: string): AiError {
  const text = body.toLowerCase();

  if (status === 404 || text.includes("not found") || text.includes("try pulling")) {
    return new AiError(
      "model_missing",
      "That model is not installed. Pull it with Ollama first.",
      body,
    );
  }
  if (
    text.includes("out of memory") ||
    text.includes("insufficient memory") ||
    text.includes("unable to allocate")
  ) {
    return new AiError(
      "out_of_memory",
      "There was not enough memory to load that model. Try a smaller model or a smaller context size.",
      body,
    );
  }
  return new AiError(
    "generation_failed",
    "The AI service rejected the request.",
    `HTTP ${status}: ${body.slice(0, 400)}`,
  );
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Combines a caller's abort signal with a deadline.
 *
 * Returned `clear` must run in a finally: without it a 5-minute model-load
 * timer keeps the process awake long after a fast reply arrived.
 */
function withTimeout(signal: AbortSignal | undefined, ms: number) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);

  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener("abort", onAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort(new AiError("timeout", "The AI service took too long to respond."));
  }, ms);

  return {
    signal: controller.signal,
    /** Pushes the deadline out again — used per chunk on a live stream. */
    extend(nextMs: number) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        controller.abort(
          new AiError("timeout", "The model stopped sending before it finished."),
        );
      }, nextMs);
    },
    clear() {
      if (timer) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export class OllamaClient {
  readonly endpoint: string;
  private readonly fetchImpl: FetchLike;
  private readonly requestTimeoutMs: number;
  private readonly firstChunkTimeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(options: OllamaClientOptions) {
    this.endpoint = normaliseEndpoint(options.endpoint);
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.firstChunkTimeoutMs = options.firstChunkTimeoutMs ?? 300_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
  }

  private async json(path: string, signal?: AbortSignal): Promise<unknown> {
    const deadline = withTimeout(signal, this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.endpoint}${path}`, {
        signal: deadline.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw classifyResponse(response.status, await response.text().catch(() => ""));
      }
      try {
        return await response.json();
      } catch (error) {
        throw new AiError(
          "malformed",
          "The AI service sent a response that could not be read.",
          error instanceof Error ? error.message : String(error),
        );
      }
    } catch (error) {
      throw classifyError(error, "request");
    } finally {
      deadline.clear();
    }
  }

  /**
   * Whether the API is answering.
   *
   * `/api/tags` is used as the health check rather than the root path: it is
   * the cheapest endpoint that proves the *API* is up, not merely that
   * something has claimed the port.
   */
  async ping(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.json("/api/tags", signal);
      return true;
    } catch {
      return false;
    }
  }

  async listModels(signal?: AbortSignal): Promise<LocalModel[]> {
    return parseModels(await this.json("/api/tags", signal));
  }

  async listLoaded(signal?: AbortSignal): Promise<LoadedModel[]> {
    return parseLoaded(await this.json("/api/ps", signal));
  }

  /**
   * Loads a model into VRAM without generating anything.
   *
   * An empty prompt is Ollama's documented way to say "just load it", which is
   * what makes optional preloading possible without burning tokens.
   */
  async preload(model: string, keepAlive: string | null, signal?: AbortSignal): Promise<void> {
    const deadline = withTimeout(signal, this.firstChunkTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.endpoint}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: "",
          stream: false,
          ...(keepAlive ? { keep_alive: keepAlive } : {}),
        }),
        signal: deadline.signal,
      });
      if (!response.ok) {
        throw classifyResponse(response.status, await response.text().catch(() => ""));
      }
    } catch (error) {
      throw classifyError(error, "request");
    } finally {
      deadline.clear();
    }
  }

  /**
   * Streams a chat completion.
   *
   * Yields events and never throws: a caller forwarding to a browser needs the
   * failure *in* the stream (the response headers are long gone by then), and a
   * generator that both yields and throws forces every consumer to handle two
   * shapes of the same thing.
   */
  async *chat(request: ChatRequest): AsyncGenerator<ChatEvent, void, void> {
    const started = Date.now();
    const deadline = withTimeout(request.signal, this.firstChunkTimeoutMs);

    try {
      const body: Record<string, unknown> = {
        model: request.model,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      };

      const options: Record<string, unknown> = {};
      if (request.contextSize && request.contextSize > 0) {
        options.num_ctx = request.contextSize;
      }
      if (Object.keys(options).length > 0) body.options = options;
      if (request.keepAlive) body.keep_alive = request.keepAlive;
      // Only sent when the user chose one. Models that do not understand it
      // ignore it; inventing a default would silently change every answer.
      if (request.reasoningEffort) body.think = request.reasoningEffort;

      const response = await this.fetchImpl(`${this.endpoint}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: deadline.signal,
      });

      if (!response.ok) {
        const error = classifyResponse(response.status, await response.text().catch(() => ""));
        yield { type: "error", code: error.code, message: error.message };
        return;
      }
      if (!response.body) {
        yield {
          type: "error",
          code: "malformed",
          message: "The AI service returned an empty response.",
        };
        return;
      }

      yield { type: "start", model: request.model };

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createNdjsonParser();

      let text = "";
      let promptTokens: number | null = null;
      let completionTokens: number | null = null;

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          // Each chunk resets the clock, so a long answer never trips the
          // deadline meant to catch a stalled one.
          deadline.extend(this.idleTimeoutMs);

          for (const event of parser.push(decoder.decode(value, { stream: true }))) {
            const record = asRecord(event);
            if (!record) continue;

            const errorText = asString(record.error);
            if (errorText) {
              const error = classifyResponse(200, errorText);
              yield { type: "error", code: error.code, message: error.message };
              return;
            }

            const message = asRecord(record.message);
            const delta = typeof message?.content === "string" ? message.content : "";
            if (delta) {
              text += delta;
              yield { type: "delta", text: delta };
            }

            if (record.done === true) {
              promptTokens = typeof record.prompt_eval_count === "number" ? record.prompt_eval_count : null;
              completionTokens = typeof record.eval_count === "number" ? record.eval_count : null;
            }
          }
        }

        for (const event of parser.flush()) {
          const record = asRecord(event);
          const message = asRecord(record?.message);
          const delta = typeof message?.content === "string" ? message.content : "";
          if (delta) {
            text += delta;
            yield { type: "delta", text: delta };
          }
        }
      } finally {
        // Releasing matters on cancellation: an un-released reader keeps the
        // socket, and Ollama keeps generating into it.
        reader.cancel().catch(() => undefined);
      }

      yield {
        type: "done",
        text,
        promptTokens,
        completionTokens,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      const classified = classifyError(error, "stream");
      yield { type: "error", code: classified.code, message: classified.message };
    } finally {
      deadline.clear();
    }
  }
}

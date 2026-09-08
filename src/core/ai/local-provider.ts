/**
 * Chat against a local Ollama instance.
 *
 * The provider owns the mapping between the application's settings and Ollama's
 * request shape, and nothing else: no persistence, no project context, no
 * process management. Those live above it, so the same class serves the
 * workspace, the settings diagnostics and the startup preload.
 */
import { OllamaClient, type OllamaClientOptions } from "./ollama-client";
import { keepAliveFor, reasoningFor, type AiSettings } from "./config";
import { aiLog } from "./logging";
import {
  AiError,
  type AIProvider,
  type ChatEvent,
  type ChatRequest,
  type LoadedModel,
  type LocalModel,
  type ProviderStatus,
} from "./types";

export class LocalChatProvider implements AIProvider {
  readonly id = "local" as const;
  readonly label = "Ollama";

  private readonly client: OllamaClient;

  constructor(client: OllamaClient) {
    this.client = client;
  }

  static fromSettings(
    settings: Pick<AiSettings, "endpoint">,
    options: Partial<OllamaClientOptions> = {},
  ): LocalChatProvider {
    return new LocalChatProvider(
      new OllamaClient({ endpoint: settings.endpoint, ...options }),
    );
  }

  get endpoint(): string {
    return this.client.endpoint;
  }

  async status(): Promise<ProviderStatus> {
    try {
      const models = await this.client.listModels();
      const status: ProviderStatus = {
        provider: this.id,
        state: "ready",
        detail:
          models.length > 0
            ? `Connected. ${models.length} model${models.length === 1 ? "" : "s"} installed.`
            : "Connected, but no models are installed yet. Pull one with Ollama.",
        endpoint: this.client.endpoint,
        error: null,
      };
      aiLog("health", { provider: this.id, state: status.state, ok: true });
      return status;
    } catch (error) {
      const failure =
        error instanceof AiError
          ? error
          : new AiError("offline", "Could not reach Ollama.", String(error));

      aiLog("health", {
        provider: this.id,
        state: "offline",
        ok: false,
        code: failure.code,
        detail: failure.detail ?? failure.message,
      });

      return {
        provider: this.id,
        state: failure.code === "offline" ? "offline" : "error",
        detail:
          failure.code === "offline"
            ? "Ollama is not running on this machine."
            : failure.message,
        endpoint: this.client.endpoint,
        error: failure.detail ?? failure.message,
      };
    }
  }

  listModels(): Promise<LocalModel[]> {
    return this.client.listModels();
  }

  listLoaded(): Promise<LoadedModel[]> {
    return this.client.listLoaded();
  }

  /** Loads a model into VRAM without generating. Used only when asked to. */
  async preload(model: string, settings: AiSettings): Promise<void> {
    aiLog("model.preload", { provider: this.id, model });
    await this.client.preload(model, keepAliveFor(settings));
  }

  chat(request: ChatRequest): AsyncGenerator<ChatEvent, void, void> {
    return this.client.chat(request);
  }

  /** Fills a request's tunables in from the user's saved preferences. */
  static requestFrom(
    settings: AiSettings,
    request: Pick<ChatRequest, "model" | "messages" | "signal">,
  ): ChatRequest {
    return {
      ...request,
      contextSize: settings.contextSize,
      keepAlive: keepAliveFor(settings),
      reasoningEffort: reasoningFor(settings),
    };
  }
}

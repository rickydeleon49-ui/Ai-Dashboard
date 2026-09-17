import "server-only";

import { getAiSettings, getApprovalPolicies } from "./settings";
import { LocalChatProvider } from "./local-provider";
import { HermesAgentProvider } from "./hermes-provider";
import type { AiSettings } from "./config";
import { DEFAULT_APPROVAL_POLICIES, type ApprovalPolicies } from "./approvals";
import type {
  AIProvider,
  AiProviderId,
  LoadedModel,
  LocalModel,
  ProviderStatus,
} from "./types";

/**
 * The one place that decides which provider answers, and whether local AI is
 * available at all in this deployment.
 *
 * Command Center runs both as a desktop application and as a web service. Only
 * the desktop build shares a machine with Ollama; a Railway deployment asking
 * 127.0.0.1 about models is asking its own container, which will never answer.
 * Detecting that once, here, is what stops the workspace from showing a
 * permanent "connecting…" to someone using the hosted copy.
 */

export type AiRuntime = "desktop" | "development" | "hosted";

export function detectRuntime(): AiRuntime {
  // Set by the desktop shell when it forks the bundled server.
  if (Boolean(process.env.DESKTOP_INTERNAL_SECRET) || process.env.DASHBOARD_LOCAL === "1") return "desktop";
  if (process.env.NODE_ENV !== "production") return "development";
  return "hosted";
}

/** Whether this process can reach services on the user's own machine. */
export function isLocalRuntime(): boolean {
  return detectRuntime() !== "hosted";
}

export function getProvider(
  settings: AiSettings,
  id: AiProviderId,
  policies: ApprovalPolicies = DEFAULT_APPROVAL_POLICIES,
): AIProvider {
  return id === "hermes"
    ? new HermesAgentProvider(settings.hermesPath, policies)
    : LocalChatProvider.fromSettings(settings);
}

/** The provider a request should use, given the mode the user is in. */
export function providerForMode(
  settings: AiSettings,
  mode: AiSettings["mode"],
  policies: ApprovalPolicies = DEFAULT_APPROVAL_POLICIES,
): AIProvider {
  return getProvider(settings, mode === "agent" ? "hermes" : "local", policies);
}

export interface AiOverview {
  runtime: AiRuntime;
  settings: AiSettings;
  /** The approval policy an agent would run under, defaults included. */
  approvals: ApprovalPolicies;
  /** Ollama's status, or a synthetic one when it cannot apply. */
  local: ProviderStatus;
  hermes: ProviderStatus;
  models: LocalModel[];
  loaded: LoadedModel[];
  /** The model the workspace will use unless the user picks another. */
  selectedModel: string | null;
}

/** A status for a provider that is switched off or cannot exist here. */
function syntheticStatus(
  provider: AiProviderId,
  state: "disabled" | "unsupported",
  endpoint: string | null,
): ProviderStatus {
  return {
    provider,
    state,
    detail:
      state === "disabled"
        ? "Local AI is turned off in Settings."
        : "Local AI needs the desktop application — this copy is running on a server.",
    endpoint,
    error: null,
  };
}

/**
 * Picks the model to start with.
 *
 * The saved default wins, but only if it is still installed: a model removed
 * with `ollama rm` would otherwise leave the selector pointing at something
 * that fails on first send. Falling back to the first installed model is what
 * makes a fresh machine work with no configuration.
 */
export function resolveModel(settings: AiSettings, models: LocalModel[]): string | null {
  if (models.length === 0) return null;
  const saved = settings.defaultModel.trim();
  if (saved && models.some((model) => model.name === saved)) return saved;
  return models[0]?.name ?? null;
}

/**
 * Everything the workspace and the settings page need, in one round trip.
 *
 * Failures are absorbed: a status call is what tells the user something is
 * wrong, so it must not itself fail and render an error page.
 */
export async function getAiOverview(): Promise<AiOverview> {
  const settings = getAiSettings();
  const approvals = getApprovalPolicies();
  const runtime = detectRuntime();
  const endpoint = settings.endpoint;

  if (!settings.enabled) {
    return {
      runtime,
      settings,
      approvals,
      local: syntheticStatus("local", "disabled", endpoint),
      hermes: syntheticStatus("hermes", "disabled", null),
      models: [],
      loaded: [],
      selectedModel: null,
    };
  }

  if (runtime === "hosted") {
    return {
      runtime,
      settings,
      approvals,
      local: syntheticStatus("local", "unsupported", endpoint),
      hermes: syntheticStatus("hermes", "unsupported", null),
      models: [],
      loaded: [],
      selectedModel: null,
    };
  }

  const local = LocalChatProvider.fromSettings(settings);
  const hermes = new HermesAgentProvider(settings.hermesPath, approvals);

  const [localStatus, hermesStatus] = await Promise.all([local.status(), hermes.status()]);

  let models: LocalModel[] = [];
  let loaded: LoadedModel[] = [];
  if (localStatus.state === "ready") {
    [models, loaded] = await Promise.all([
      local.listModels().catch(() => []),
      // /api/ps is newer than /api/tags; an older Ollama simply reports nothing
      // resident rather than making the whole page look broken.
      local.listLoaded().catch(() => []),
    ]);
  }

  return {
    runtime,
    settings,
    approvals,
    local: localStatus,
    hermes: hermesStatus,
    models,
    loaded,
    selectedModel: resolveModel(settings, models),
  };
}

/**
 * Provider probes and models for the Agent Workflow Control Center (AW.1, design §3, §9).
 *
 * Probes CLI adapters (Claude Code, Fake Agent) to check installation status,
 * resolved executable, version, authentication, and configured models.
 */
import { claudeAdapter } from "./adapters/claude-code";
import { antigravityAdapter } from "./adapters/antigravity";
import { codexAdapter } from "./adapters/codex";
import { CODEX_MODELS } from "./codex-constants";
import { fakeAdapter } from "./adapters/fake";
import type { ProbeResult } from "./adapters/types";

export interface ProviderProbeInfo {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
  authenticated: boolean | "unknown";
  models: string[];
  executable?: string;
  error?: string;
  tried?: string[];
}

export interface ProviderProbeDeps {
  claudeProbe?: () => Promise<ProbeResult>;
  codexProbe?: () => Promise<ProbeResult>;
  antigravityProbe?: () => Promise<ProbeResult>;
  fakeProbe?: () => Promise<ProbeResult>;
  includeFake?: boolean;
}

export const CLAUDE_CODE_MODELS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-1",
];

export { CODEX_MODELS };

/** Antigravity's models come from `agy models` on demand; the run form accepts a free-text model until then. */
export const ANTIGRAVITY_MODELS: string[] = [];

export const FAKE_AGENT_MODELS = [
  "default",
  "success",
  "failure",
  "syntax_error",
];

/**
 * Probes existing agent adapters in src/core/agents/adapters/ using their probe() functions.
 */
export async function getProviderProbes(
  deps: ProviderProbeDeps = {},
): Promise<ProviderProbeInfo[]> {
  const providers: ProviderProbeInfo[] = [];

  // 1. Claude Code
  const runClaudeProbe = deps.claudeProbe ?? (() => claudeAdapter.probe());
  try {
    const res = await runClaudeProbe();
    providers.push({
      id: claudeAdapter.id,
      name: claudeAdapter.displayName,
      installed: res.installed,
      version: res.version,
      authenticated: res.authenticated,
      models: CLAUDE_CODE_MODELS,
      executable: res.executable,
      error: res.error,
      tried: res.tried,
    });
  } catch (err) {
    providers.push({
      id: claudeAdapter.id,
      name: claudeAdapter.displayName,
      installed: false,
      authenticated: "unknown",
      models: CLAUDE_CODE_MODELS,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Codex (planner and reviewer only; never reads ~/.codex)
  const runCodexProbe = deps.codexProbe ?? (() => codexAdapter.probe());
  try {
    const res = await runCodexProbe();
    providers.push({
      id: codexAdapter.id,
      name: codexAdapter.displayName,
      installed: res.installed,
      version: res.version,
      authenticated: res.authenticated,
      models: CODEX_MODELS,
      executable: res.executable,
      error: res.error,
      tried: res.tried,
    });
  } catch (err) {
    providers.push({
      id: codexAdapter.id,
      name: codexAdapter.displayName,
      installed: false,
      authenticated: "unknown",
      models: CODEX_MODELS,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Antigravity (implementer only; probe = `agy --version` plus the cached sign-in result, never a model turn)
  const runAntigravityProbe = deps.antigravityProbe ?? (() => antigravityAdapter.probe());
  try {
    const res = await runAntigravityProbe();
    providers.push({
      id: antigravityAdapter.id,
      name: antigravityAdapter.displayName,
      installed: res.installed,
      version: res.version,
      authenticated: res.authenticated,
      models: ANTIGRAVITY_MODELS,
      executable: res.executable,
      error: res.error,
      tried: res.tried,
    });
  } catch (err) {
    providers.push({
      id: antigravityAdapter.id,
      name: antigravityAdapter.displayName,
      installed: false,
      authenticated: "unknown",
      models: ANTIGRAVITY_MODELS,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 4. Fake Agent
  const runFakeProbe = deps.fakeProbe ?? (() => fakeAdapter.probe());
  try {
    const res = await runFakeProbe();
    providers.push({
      id: fakeAdapter.id,
      name: fakeAdapter.displayName,
      installed: res.installed,
      version: res.version,
      authenticated: res.authenticated,
      models: FAKE_AGENT_MODELS,
      executable: res.executable,
      error: res.error,
      tried: res.tried,
    });
  } catch (err) {
    providers.push({
      id: fakeAdapter.id,
      name: fakeAdapter.displayName,
      installed: false,
      authenticated: "unknown",
      models: FAKE_AGENT_MODELS,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return providers;
}

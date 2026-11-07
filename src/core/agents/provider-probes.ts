/**
 * Provider probes and models for the Agent Workflow Control Center (AW.1, design §3, §9).
 *
 * Probes CLI adapters (Claude Code, Fake Agent) to check installation status,
 * resolved executable, version, authentication, and configured models.
 */
import { claudeAdapter } from "./adapters/claude-code";
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
  fakeProbe?: () => Promise<ProbeResult>;
  includeFake?: boolean;
}

export const CLAUDE_CODE_MODELS = [
  "claude-3-7-sonnet-20250219",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
  "claude-opus-5-5",
];

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

  // 2. Fake Agent
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

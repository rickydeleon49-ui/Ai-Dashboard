/**
 * Fake agent adapter for automated testing and demo environments (§3, §8, §14, §15 step 8).
 *
 * Runs tests/fixtures/fake-agent.mjs via process.execPath, reuses claude-code's parseLine,
 * and always probes as installed and authenticated.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaudeLine } from "./claude-code";
import type {
  AgentAdapter,
  Invocation,
  InvocationRequest,
  NormalizedEvent,
  ProbeResult,
} from "./types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function getFakeAgentFixturePath(): string {
  // Try relative to this file (src/core/agents/adapters -> tests/fixtures)
  const relPath = path.resolve(
    __dirname,
    "../../../../tests/fixtures/fake-agent.mjs",
  );
  if (fs.existsSync(relPath)) {
    return relPath;
  }
  // Try from process.cwd()
  const cwdPath = path.resolve(process.cwd(), "tests/fixtures/fake-agent.mjs");
  if (fs.existsSync(cwdPath)) {
    return cwdPath;
  }
  return relPath;
}

export function buildFakeInvocation(req: InvocationRequest): Invocation {
  const fixturePath = getFakeAgentFixturePath();
  const scenario = req.model || process.env.FAKE_AGENT_SCENARIO || "success";

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.FAKE_AGENT_SCENARIO = scenario;

  return {
    file: process.execPath,
    args: [fixturePath],
    cwd: req.workspacePath,
    env,
    stdin: req.prompt,
    grantFile: req.grantDir
      ? path.join(req.grantDir, "claude-settings.json")
      : undefined,
  };
}

export const fakeAdapter: AgentAdapter = {
  id: "fake",
  displayName: "Fake Agent",
  probe: async (): Promise<ProbeResult> => ({
    installed: true,
    authenticated: true,
    version: "1.0.0",
    executable: process.execPath,
  }),
  buildInvocation: (req: InvocationRequest): Invocation =>
    buildFakeInvocation(req),
  parseLine: (obj: unknown): NormalizedEvent[] => parseClaudeLine(obj),
};

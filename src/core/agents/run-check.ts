/**
 * Runs one policy check (design §7): the runner executes the project's
 * configured argv itself, never the agent. `shell` is always false, the
 * executable is resolved before spawning, and the child gets a small
 * allowlisted environment so the dashboard's secrets never reach a project's
 * test command.
 */
import {
  spawnAgentProcess,
  stopAgentProcess,
  type AgentExit,
  type AgentProcessHandle,
  type SpawnAgentOptions,
} from "./process";
import { resolveExecutable, isSafeAbsolute, type ResolveResult } from "./resolve-executable";
import type { CheckResult, PolicyCheck } from "./orchestrator";

/** Environment variables a check may see (compared case-insensitively). */
export const CHECK_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
];

export const DEFAULT_CHECK_TIMEOUT_SEC = 600;
export const MAX_CHECK_OUTPUT_CHARS = 16 * 1024;

export interface RunCheckDeps {
  resolve?: (command: string, env: Record<string, string | undefined>) => ResolveResult;
  spawn?: (options: SpawnAgentOptions) => AgentProcessHandle;
  stop?: (handle: AgentProcessHandle, options?: { graceMs?: number }) => Promise<AgentExit>;
  baseEnv?: Record<string, string | undefined>;
  /** Overrides the check's own timeout (tests). */
  timeoutMs?: number;
  stopGraceMs?: number;
}

export function buildCheckEnv(
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const allowed = new Set(CHECK_ENV_ALLOWLIST);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined && allowed.has(key.toUpperCase())) env[key] = value;
  }
  return env;
}

function defaultResolve(command: string, env: Record<string, string | undefined>): ResolveResult {
  if (isSafeAbsolute(command, process.platform)) {
    return resolveExecutable(command, { explicitPath: command, env });
  }
  return resolveExecutable(command, { env });
}

export async function runPolicyCheck(
  check: PolicyCheck,
  cwd: string,
  signal: AbortSignal,
  deps: RunCheckDeps = {},
): Promise<CheckResult> {
  const started = Date.now();
  const fail = (output: string): CheckResult => ({
    name: check.name,
    exitCode: null,
    timedOut: false,
    durationMs: Date.now() - started,
    output,
  });

  const [command, ...rest] = check.argv;
  if (!command) return fail("check has an empty argv");

  const env = buildCheckEnv(deps.baseEnv ?? process.env);
  const resolved = (deps.resolve ?? defaultResolve)(command, env);
  if (!resolved.ok) return fail(`could not resolve executable "${command}"`);

  let output = "";
  const append = (text: string) => {
    output += text + "\n";
    if (output.length > MAX_CHECK_OUTPUT_CHARS * 2) output = output.slice(-MAX_CHECK_OUTPUT_CHARS);
  };

  const spawn = deps.spawn ?? spawnAgentProcess;
  const stop = deps.stop ?? stopAgentProcess;
  let handle: AgentProcessHandle;
  try {
    handle = spawn({
      file: resolved.file,
      args: [...resolved.prefixArgs, ...rest],
      cwd,
      env: env as NodeJS.ProcessEnv,
      onJson: (value) => append(JSON.stringify(value)),
      onText: (_stream, text) => append(text),
    });
  } catch (error) {
    return fail(`could not start: ${error instanceof Error ? error.message : String(error)}`);
  }

  let timedOut = false;
  const stopIt = () => {
    stop(handle, deps.stopGraceMs === undefined ? undefined : { graceMs: deps.stopGraceMs }).catch(() => {});
  };
  const timeoutMs = deps.timeoutMs ?? (check.timeoutSec ?? DEFAULT_CHECK_TIMEOUT_SEC) * 1000;
  const timer = setTimeout(() => {
    timedOut = true;
    stopIt();
  }, timeoutMs);
  const onAbort = () => stopIt();
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  let exit: AgentExit;
  try {
    exit = await handle.done;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
  if (exit.error) append(exit.error);

  return {
    name: check.name,
    exitCode: timedOut ? null : exit.code,
    timedOut,
    durationMs: Date.now() - started,
    output: output.slice(-MAX_CHECK_OUTPUT_CHARS),
  };
}

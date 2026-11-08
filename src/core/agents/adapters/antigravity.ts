/**
 * Antigravity (`agy`) agent adapter, implementer role only (design §3.2, §16.3 AW.3 row 1).
 *
 * `agy` is a native executable with a real headless mode. The prompt goes on
 * stdin as one stream-json user message (a large prompt would overflow the
 * Windows command line), and `--output-format stream-json` events are mapped
 * to normalized run events. The CLI's own `result.status` is never the outcome:
 * a SUCCESS turn that contains an ERROR tool step is a failed run (§7).
 *
 * Not registered in role-runners or the orchestrator (AW3-04) and no tool
 * allowlist or path monitor here (AW3-03).
 */
import { resolveExecutable, type ResolveOptions } from "../resolve-executable";
import { defaultExecFile as runCommand, type CommandRunner } from "./claude-code";
import type {
  AgentAdapter,
  Invocation,
  InvocationRequest,
  NormalizedEvent,
  ProbeResult,
} from "./types";

export type { CommandRunner };

/** Antigravity's documented effort list (`agy --help`). */
export const ANTIGRAVITY_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AntigravityEffort = (typeof ANTIGRAVITY_EFFORT_LEVELS)[number];

/** Per-stage limit when the caller does not pass one (seconds). */
export const ANTIGRAVITY_DEFAULT_PRINT_TIMEOUT_SECONDS = 900;

const MODEL_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Flags that must never reach a spawned `agy` (design §3.2 "Refused", plus the
 * Codex-style bypass names and the flags that would change which project,
 * settings or directories a run touches). `--mode` other than accept-edits is
 * checked separately in assertAntigravityArgvAllowed.
 */
export const ANTIGRAVITY_DENIED_FLAGS: readonly string[] = [
  "--dangerously-skip-permissions",
  "--yolo",
  "--dangerously-bypass-approvals-and-sandbox",
  "--approve-for-me",
  "--add-dir",
  "--remote-control",
  "--remote-agent",
  "--continue",
  "-c",
  "--prompt-interactive",
  "-i",
  "--prompt",
  "--settings",
  "--project",
  "--new-project",
];

/** Subcommands that must never appear in an unattended run's argv. */
export const ANTIGRAVITY_DENIED_SUBCOMMANDS: readonly string[] = [
  "install",
  "update",
  "remote-control",
  "mic-serve",
];

/** Throws when argv contains a refused flag, subcommand, or a `--mode` other than accept-edits. */
export function assertAntigravityArgvAllowed(args: readonly string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    for (const denied of ANTIGRAVITY_DENIED_FLAGS) {
      if (arg === denied || arg.startsWith(`${denied}=`)) {
        throw new Error(`Denied Antigravity flag detected: ${arg}`);
      }
    }
    if (ANTIGRAVITY_DENIED_SUBCOMMANDS.includes(arg)) {
      throw new Error(`Denied Antigravity subcommand detected: ${arg}`);
    }
    if (arg === "--mode") {
      const next = args[i + 1];
      if (next !== "accept-edits") {
        throw new Error(`Denied Antigravity mode detected: --mode ${String(next)}`);
      }
    } else if (arg.startsWith("--mode=") && arg !== "--mode=accept-edits") {
      throw new Error(`Denied Antigravity mode detected: ${arg}`);
    }
  }
}

/** Validates effort against Antigravity's list before anything is spawned. */
export function validateAntigravityEffort(effort: unknown): AntigravityEffort {
  if (
    typeof effort === "string" &&
    (ANTIGRAVITY_EFFORT_LEVELS as readonly string[]).includes(effort)
  ) {
    return effort as AntigravityEffort;
  }
  throw new Error(
    `Invalid Antigravity effort: ${String(effort)}. Supported values are: ${ANTIGRAVITY_EFFORT_LEVELS.join(", ")}.`,
  );
}

// Explicit allowlist (lowercase). No API keys pass through: agy signs in from
// its own config under the user profile.
const ALLOWED_ENV_VARS = new Set([
  "path",
  "pathext",
  "systemroot",
  "windir",
  "comspec",
  "temp",
  "tmp",
  "home",
  "userprofile",
  "appdata",
  "localappdata",
  "lang",
  "lc_all",
  "term",
  "https_proxy",
  "http_proxy",
  "no_proxy",
]);

export function buildAntigravityEnv(
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (ALLOWED_ENV_VARS.has(key.toLowerCase())) env[key] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Models and ANSI handling
// ---------------------------------------------------------------------------

/** Removes terminal control sequences (CSI such as ESC[K, OSC, and lone ESC). */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "");
}

export interface AntigravityModel {
  id: string;
  label: string;
}

/**
 * Parses `agy models` output: ANSI stripped, then one `<id>\t<label>` line per
 * model. The "Fetching available models..." header and any line without a
 * valid ID are ignored.
 */
export function parseAntigravityModels(output: string): AntigravityModel[] {
  const models: AntigravityModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.replace(/\r/g, "").trim();
    if (line === "") continue;
    const parts = line.split(/\t+|\s{2,}/);
    const id = parts[0]?.trim();
    if (id === undefined || !MODEL_REGEX.test(id) || /\s/.test(id)) continue;
    const label = parts.slice(1).join(" ").trim();
    if (label === "") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label });
  }
  return models;
}

// ---------------------------------------------------------------------------
// Probe, models, sign-in
// ---------------------------------------------------------------------------

export interface AntigravityProbeDeps {
  resolveExecutable?: typeof resolveExecutable;
  runner?: CommandRunner;
  resolveOptions?: ResolveOptions;
}

/** `agy --version` only. Never runs a model turn (the sign-in check is on demand). */
export async function probeAntigravity(
  deps: AntigravityProbeDeps = {},
): Promise<ProbeResult> {
  const resolve = deps.resolveExecutable ?? resolveExecutable;
  const runner = deps.runner ?? runCommand;
  const res = resolve("agy", deps.resolveOptions);

  if (!res.ok) {
    return { installed: false, authenticated: "unknown", tried: res.tried };
  }

  const versionRun = await runner(res.file, [...res.prefixArgs, "--version"], {
    timeout: 15000,
    env: buildAntigravityEnv(),
  });
  if (versionRun.error && versionRun.stdout.trim() === "") {
    return {
      installed: false,
      authenticated: "unknown",
      executable: res.file,
      error: versionRun.error.message,
    };
  }
  const match = /(\d+\.\d+\.\d+[^\s]*)/.exec(stripAnsi(versionRun.stdout));
  const version = match ? match[1] : stripAnsi(versionRun.stdout).trim() || undefined;

  const cached = getAntigravitySignInCache();
  return {
    installed: true,
    version,
    authenticated: cached ? cached.authenticated : "unknown",
    executable: res.file,
  };
}

/** Runs `agy models` and returns the parsed list (empty when agy is missing or fails). */
export async function listAntigravityModels(
  deps: AntigravityProbeDeps = {},
): Promise<AntigravityModel[]> {
  const resolve = deps.resolveExecutable ?? resolveExecutable;
  const runner = deps.runner ?? runCommand;
  const res = resolve("agy", deps.resolveOptions);
  if (!res.ok) return [];
  const run = await runner(res.file, [...res.prefixArgs, "models"], {
    timeout: 30000,
    env: buildAntigravityEnv(),
  });
  return parseAntigravityModels(run.stdout);
}

export interface AntigravitySignInResult {
  authenticated: boolean | "unknown";
  /** Epoch milliseconds from the injected clock. */
  checkedAt: number;
  error?: string;
}

export interface AntigravitySignInDeps extends AntigravityProbeDeps {
  /** Clock, epoch milliseconds. */
  now?: () => number;
  /** Reuse a cached result younger than this (default 10 minutes). */
  maxAgeMs?: number;
  /** Ignore the cache and run the turn. */
  force?: boolean;
}

export const ANTIGRAVITY_SIGN_IN_MAX_AGE_MS = 10 * 60 * 1000;

let signInCache: AntigravitySignInResult | undefined;

/** The last sign-in check result, or undefined when none ran in this process. */
export function getAntigravitySignInCache(): AntigravitySignInResult | undefined {
  return signInCache ? { ...signInCache } : undefined;
}

export function clearAntigravitySignInCache(): void {
  signInCache = undefined;
}

/**
 * Minimal `-p` turn (about 25,000 tokens, §3.2). Only ever called on demand,
 * never from probe(). A SUCCESS result means signed in, any other result
 * status means not signed in, and no result event is "unknown".
 */
export async function checkAntigravitySignIn(
  deps: AntigravitySignInDeps = {},
): Promise<AntigravitySignInResult> {
  const now = deps.now ?? Date.now;
  const maxAge = deps.maxAgeMs ?? ANTIGRAVITY_SIGN_IN_MAX_AGE_MS;
  if (!deps.force && signInCache && now() - signInCache.checkedAt < maxAge) {
    return { ...signInCache };
  }

  const resolve = deps.resolveExecutable ?? resolveExecutable;
  const runner = deps.runner ?? runCommand;
  const res = resolve("agy", deps.resolveOptions);
  let result: AntigravitySignInResult;
  if (!res.ok) {
    result = { authenticated: "unknown", checkedAt: now(), error: "agy not installed" };
  } else {
    const args = [
      ...res.prefixArgs,
      "-p",
      "Reply with the single word OK.",
      "--output-format",
      "stream-json",
      "--mode",
      "accept-edits",
      "--sandbox",
      "--disable-slash-commands",
      "--print-timeout",
      "120s",
    ];
    assertAntigravityArgvAllowed(args);
    const run = await runner(res.file, args, {
      timeout: 150000,
      env: buildAntigravityEnv(),
    });
    const status = findResultStatus(run.stdout);
    if (status === undefined) {
      result = {
        authenticated: "unknown",
        checkedAt: now(),
        error: run.error?.message ?? (run.stderr.trim().slice(0, 300) || "no result event"),
      };
    } else {
      result = { authenticated: status === "SUCCESS", checkedAt: now() };
    }
  }
  signInCache = result;
  return { ...result };
}

function findResultStatus(stdout: string): string | undefined {
  let status: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj.event === "result" && isRecord(obj.result)) {
        const s = obj.result.status;
        if (typeof s === "string") status = s;
      }
    } catch {
      // ignore partial lines
    }
  }
  return status;
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

export interface AntigravityInvocationDeps {
  resolveExecutable?: typeof resolveExecutable;
  baseEnv?: Record<string, string | undefined>;
  executableFile?: string;
  prefixArgs?: string[];
  /** Per-stage limit passed as `--print-timeout <n>s`. */
  printTimeoutSeconds?: number;
}

export function buildAntigravityInvocation(
  req: InvocationRequest,
  deps: AntigravityInvocationDeps = {},
): Invocation {
  if (req.model !== undefined && !MODEL_REGEX.test(req.model)) {
    throw new Error(`Invalid model name: ${req.model}`);
  }
  const effort = req.effort === undefined ? undefined : validateAntigravityEffort(req.effort);
  const timeout = deps.printTimeoutSeconds ?? ANTIGRAVITY_DEFAULT_PRINT_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86400) {
    throw new Error(`Invalid print timeout: ${String(timeout)}`);
  }
  if (req.resumeSessionId !== undefined && !UUID_REGEX.test(req.resumeSessionId)) {
    throw new Error(`Invalid conversation id: ${req.resumeSessionId}`);
  }

  let file = deps.executableFile;
  let prefixArgs = deps.prefixArgs ?? [];
  if (!file) {
    const res = (deps.resolveExecutable ?? resolveExecutable)("agy");
    if (!res.ok) {
      throw new Error(`Could not resolve the agy executable. Tried: ${res.tried.join(", ")}`);
    }
    file = res.file;
    prefixArgs = res.prefixArgs;
  }

  const args = [
    ...prefixArgs,
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
  ];
  if (req.model) args.push("--model", req.model);
  if (effort) args.push("--effort", effort);
  args.push(
    "--mode",
    "accept-edits",
    "--sandbox",
    "--disable-slash-commands",
    "--print-timeout",
    `${timeout}s`,
  );
  if (req.resumeSessionId) args.push("--conversation", req.resumeSessionId);

  assertAntigravityArgvAllowed(args);

  return {
    file,
    args,
    cwd: req.workspacePath,
    env: buildAntigravityEnv(deps.baseEnv ?? process.env),
    stdin: `${JSON.stringify({ event: "user", message: { content: req.prompt } })}\n`,
  };
}

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

export type AntigravityFailureKind = "cli_status" | "tool_error" | "no_result";

export interface AntigravityFailure {
  kind: AntigravityFailureKind;
  message: string;
  toolName?: string;
  stepIndex?: number;
}

export interface AntigravityDeniedAction {
  action: string;
  displayName?: string;
}

export type AntigravityRunOutcome = "running" | "succeeded" | "failed";

function isRecord(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function clip(text: string, max = 4000): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Per-invocation state for one `agy` run. Feed it every parsed JSON line (and
 * call finish() at process exit); read outcome/failures afterwards. There are
 * no module globals, so concurrent runs cannot interfere.
 */
export class AntigravityRunAccumulator {
  conversationId: string | undefined;
  model: string | undefined;
  resultStatus: string | undefined;
  readonly failures: AntigravityFailure[] = [];
  readonly deniedActions: AntigravityDeniedAction[] = [];
  readonly errorSteps: { stepIndex: number; toolName?: string; message: string }[] = [];
  private sawResult = false;
  private finished = false;

  get outcome(): AntigravityRunOutcome {
    if (this.failures.length > 0) return "failed";
    return this.sawResult ? "succeeded" : "running";
  }

  /** Call when the process has exited. A run with no result event is failed. */
  finish(): NormalizedEvent[] {
    if (this.finished) return [];
    this.finished = true;
    if (this.sawResult) return [];
    const failure: AntigravityFailure = {
      kind: "no_result",
      message: "Antigravity exited without a result event",
    };
    this.failures.push(failure);
    return [{ agent: "implementer", kind: "error", payload: failure }];
  }

  ingest(obj: unknown): NormalizedEvent[] {
    if (!isRecord(obj)) return [];
    switch (obj.event) {
      case "init":
        return this.onInit(obj);
      case "step_update":
        return isRecord(obj.step_update) ? this.onStep(obj.step_update) : [];
      case "result":
        return isRecord(obj.result) ? this.onResult(obj.result) : [];
      default:
        return [];
    }
  }

  private onInit(obj: Record<string, any>): NormalizedEvent[] {
    const inner = isRecord(obj.init) ? obj.init : {};
    this.conversationId = str(obj.conversation_id) ?? this.conversationId;
    this.model = str(inner.model) ?? this.model;
    return [
      {
        agent: "implementer",
        kind: "output",
        payload: {
          sessionId: this.conversationId,
          model: this.model,
          cwd: str(inner.cwd),
        },
      },
    ];
  }

  private onStep(step: Record<string, any>): NormalizedEvent[] {
    this.conversationId = this.conversationId ?? str(step.conversation_id);
    const state = str(step.state);
    const stepIndex = typeof step.step_index === "number" ? step.step_index : undefined;

    if (step.step_type === "agent_response") {
      const text = str(step.text_delta);
      if (text === undefined || text === "") return [];
      return [{ agent: "implementer", kind: "output", payload: { text } }];
    }

    if (step.step_type === "tool") {
      const info = isRecord(step.tool_info) ? step.tool_info : {};
      const params = isRecord(info.parameters) ? info.parameters : {};
      const name = str(step.tool_name) ?? str(info.name);
      const filePath = str(params.Path);
      const command = str(params.CommandLine);
      const base = { stepIndex, name, state, path: filePath, command };

      if (state === "ACTIVE") {
        return [
          {
            agent: "implementer",
            kind: "tool_call",
            payload: { id: `${this.conversationId ?? ""}:${stepIndex ?? ""}`, ...base },
          },
        ];
      }

      const isError = state === "ERROR";
      let content = "";
      if (isError) {
        const err = isRecord(info.error) ? info.error : isRecord(step.error) ? step.error : {};
        content = str(err.message) ?? "tool error";
        this.errorSteps.push({
          stepIndex: stepIndex ?? -1,
          toolName: name,
          message: clip(content, 500),
        });
      } else if (typeof info.output === "string") {
        content = info.output;
      }
      return [
        {
          agent: "implementer",
          kind: "tool_result",
          payload: {
            toolUseId: `${this.conversationId ?? ""}:${stepIndex ?? ""}`,
            isError,
            content: clip(content),
            ...base,
          },
        },
      ];
    }

    return [];
  }

  private onResult(result: Record<string, any>): NormalizedEvent[] {
    this.sawResult = true;
    this.conversationId = str(result.conversation_id) ?? this.conversationId;
    this.resultStatus = str(result.status);
    const events: NormalizedEvent[] = [];

    if (this.resultStatus !== "SUCCESS") {
      this.failures.push({
        kind: "cli_status",
        message: `Antigravity result status was ${String(this.resultStatus)}`,
      });
    }
    // SUCCESS with any ERROR tool step is still a failed run (§7, smoke test 1).
    for (const e of this.errorSteps) {
      this.failures.push({
        kind: "tool_error",
        message: e.message,
        toolName: e.toolName,
        stepIndex: e.stepIndex,
      });
    }

    const failed = this.failures.length > 0;
    events.push({
      agent: "implementer",
      kind: "output",
      payload: {
        final: true,
        isError: failed,
        status: this.resultStatus,
        sessionId: this.conversationId,
        numTurns: typeof result.num_turns === "number" ? result.num_turns : undefined,
        durationMs:
          typeof result.duration_seconds === "number"
            ? Math.round(result.duration_seconds * 1000)
            : undefined,
        usage: isRecord(result.usage) ? result.usage : undefined,
        text: str(result.response) ?? "",
      },
    });

    if (Array.isArray(result.denied_actions)) {
      for (const d of result.denied_actions) {
        if (!isRecord(d)) continue;
        const denied: AntigravityDeniedAction = {
          action: str(d.action) ?? "unknown",
          displayName: str(d.display_name),
        };
        this.deniedActions.push(denied);
        events.push({
          agent: "implementer",
          kind: "warning",
          payload: { deniedAction: denied.action, displayName: denied.displayName },
        });
      }
    }

    for (const f of this.failures) {
      events.push({ agent: "implementer", kind: "error", payload: { ...f } });
    }
    return events;
  }
}

/** Stateless single-line mapping (use AntigravityRunAccumulator to get failure kinds). */
export function parseAntigravityLine(obj: unknown): NormalizedEvent[] {
  return new AntigravityRunAccumulator().ingest(obj);
}

export const antigravityAdapter: AgentAdapter = {
  id: "antigravity",
  displayName: "Antigravity",
  supportsResume: true,
  probe: (deps?: unknown) => probeAntigravity(deps as AntigravityProbeDeps | undefined),
  buildInvocation: (req: InvocationRequest) => buildAntigravityInvocation(req),
  parseLine: (obj: unknown) => parseAntigravityLine(obj),
};

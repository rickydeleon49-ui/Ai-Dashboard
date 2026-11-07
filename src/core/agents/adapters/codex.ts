/**
 * Codex CLI adapter for the planner and reviewer roles (design §3.1, §5A, §16.2 row 2).
 *
 * Codex runs `codex exec` read-only. The prompt goes on stdin, the result is the
 * `-o` file validated against the Zod schemas (never stdout prose), and the
 * `--json` events are mapped to normalized run events.
 *
 * Not registered in the orchestrator or provider list yet: a later round wires it in.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createNdjsonParser } from "../../ai/ndjson";
import { spawnAgentProcess, stopAgentProcess, type AgentExit } from "../process";
import { resolveExecutable, type ResolveOptions } from "../resolve-executable";
import {
  plannerOutputSchema,
  reviewerOutputSchema,
  type PlannerOutput,
  type ReviewerOutput,
} from "../schema";
import { reviewerJsonSchema, writeSchemaFile } from "../schemas/export";
import type { EventKind } from "../types";
import type { ProbeResult } from "./types";

export type CodexRole = "planner" | "reviewer";

/** Codex's own reasoning-effort list (verified against the service, design §3.1). */
export const CODEX_EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type CodexEffort = (typeof CODEX_EFFORT_LEVELS)[number];

export const CODEX_DEFAULT_EFFORT: CodexEffort = "medium";

const MODEL_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;

/** Flags that must never reach a spawned Codex (design §3.1 "Refused"). */
export const CODEX_DENIED_FLAGS: readonly string[] = [
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--approve-for-me",
  "--ignore-rules",
];

/** Throws when argv contains a refused flag, including `-s danger-full-access`. */
export function assertCodexArgvAllowed(args: readonly string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    for (const denied of CODEX_DENIED_FLAGS) {
      if (arg === denied || arg.startsWith(`${denied}=`)) {
        throw new Error(`Denied Codex flag detected: ${arg}`);
      }
    }
    const next = args[i + 1];
    if (
      (arg === "-s" || arg === "--sandbox") &&
      next !== undefined &&
      /^danger-full-access$/i.test(next)
    ) {
      throw new Error(`Denied Codex flag detected: ${arg} ${next}`);
    }
    if (/^(?:-s|--sandbox)=danger-full-access$/i.test(arg)) {
      throw new Error(`Denied Codex flag detected: ${arg}`);
    }
  }
}

/** Validates effort against Codex's list before anything is spawned. */
export function validateCodexEffort(effort: unknown): CodexEffort {
  if (typeof effort === "string" && (CODEX_EFFORT_LEVELS as readonly string[]).includes(effort)) {
    return effort as CodexEffort;
  }
  throw new Error(
    `Invalid Codex reasoning effort: ${String(effort)}. Supported values are: ${CODEX_EFFORT_LEVELS.join(", ")}.`,
  );
}

export interface CodexArgvOptions {
  /** Directory in run storage that holds the schema and output files. */
  runDir: string;
  worktree: string;
  model?: string;
  effort?: string;
}

export interface CodexArgv {
  /** Argument list without the executable (or its prefix args). */
  args: string[];
  schemaFile: string;
  outputFile: string;
}

export function codexOutputFilePath(runDir: string, role: CodexRole): string {
  return path.resolve(runDir, `${role}-last-message.json`);
}

/**
 * Codex strict structured output requires every property in `required`.
 * Optional reviewer finding fields (path, line) become required and nullable;
 * parseCodexResult turns null back into "absent" before Zod runs.
 */
export function codexReviewerJsonSchema(): Record<string, unknown> {
  const schema = structuredClone(reviewerJsonSchema()) as Record<string, any>;
  const items = schema.properties?.findings?.items;
  if (items?.properties) {
    for (const key of ["path", "line"]) {
      const prop = items.properties[key];
      if (prop) items.properties[key] = { anyOf: [prop, { type: "null" }] };
    }
    items.required = Object.keys(items.properties);
  }
  return schema;
}

/** Writes the schema file Codex gets for `role` into `dir` and returns its path. */
export async function writeCodexSchemaFile(dir: string, role: CodexRole): Promise<string> {
  if (role === "planner") return writeSchemaFile(dir, "planner");
  if (role !== "reviewer") throw new Error(`Unsupported Codex role: ${String(role)}`);
  const filePath = path.resolve(dir, "reviewer-output.schema.json");
  await fs.promises.writeFile(
    filePath,
    `${JSON.stringify(codexReviewerJsonSchema(), null, 2)}\n`,
    "utf8",
  );
  return filePath;
}

/** Builds the exact argv (design §16.2 row 2); writes the schema file first. */
export async function buildCodexArgv(role: CodexRole, opts: CodexArgvOptions): Promise<CodexArgv> {
  if (role !== "planner" && role !== "reviewer") {
    throw new Error(`Unsupported Codex role: ${String(role)}`);
  }
  if (opts.model !== undefined && !MODEL_REGEX.test(opts.model)) {
    throw new Error(`Invalid model name: ${opts.model}`);
  }
  const effort = opts.effort === undefined ? undefined : validateCodexEffort(opts.effort);

  fs.mkdirSync(opts.runDir, { recursive: true });
  const schemaFile = await writeCodexSchemaFile(opts.runDir, role);
  const outputFile = codexOutputFilePath(opts.runDir, role);

  const args = ["exec", "-", "--json", "--output-schema", schemaFile, "-o", outputFile];
  if (opts.model) args.push("-m", opts.model);
  if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
  args.push("-s", "read-only", "-C", opts.worktree, "--ignore-user-config");

  assertCodexArgvAllowed(args);
  return { args, schemaFile, outputFile };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface CodexEvent {
  agent: CodexRole;
  kind: EventKind;
  payload: unknown;
}

/** Extracts the real reason from Codex's double-encoded error message. */
export function decodeCodexErrorMessage(message: unknown): string {
  if (typeof message !== "string") return "Codex reported an error";
  const trimmed = message.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith('"')) {
    try {
      const inner: unknown = JSON.parse(trimmed);
      if (typeof inner === "string") return inner;
      if (inner && typeof inner === "object") {
        const rec = inner as Record<string, unknown>;
        const err = rec.error;
        if (err && typeof err === "object") {
          const m = (err as Record<string, unknown>).message;
          if (typeof m === "string" && m) return m;
        }
        if (typeof err === "string" && err) return err;
        if (typeof rec.message === "string" && rec.message) return rec.message;
      }
    } catch {
      // Not a second JSON document: fall back to the raw string.
    }
  }
  return message;
}

export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Maps one parsed `--json` line to normalized events. */
export function parseCodexLine(obj: unknown, role: CodexRole): CodexEvent[] {
  if (obj === null || typeof obj !== "object") return [];
  const rec = obj as Record<string, unknown>;

  switch (rec.type) {
    case "thread.started":
      return typeof rec.thread_id === "string"
        ? [{ agent: role, kind: "output", payload: { sessionId: rec.thread_id } }]
        : [];
    case "item.completed": {
      const item = rec.item as Record<string, unknown> | undefined;
      if (item && item.type === "agent_message" && typeof item.text === "string") {
        return [{ agent: role, kind: "output", payload: { text: item.text } }];
      }
      return [];
    }
    case "turn.completed": {
      const u = (rec.usage ?? {}) as Record<string, unknown>;
      const usage: CodexUsage = {
        inputTokens: num(u.input_tokens),
        cachedInputTokens: num(u.cached_input_tokens),
        cacheWriteInputTokens: num(u.cache_write_input_tokens),
        outputTokens: num(u.output_tokens),
        reasoningOutputTokens: num(u.reasoning_output_tokens),
      };
      return [{ agent: role, kind: "output", payload: { final: true, usage } }];
    }
    case "error":
      return [
        { agent: role, kind: "error", payload: { message: decodeCodexErrorMessage(rec.message) } },
      ];
    case "turn.failed": {
      const err = rec.error as Record<string, unknown> | undefined;
      return [
        { agent: role, kind: "error", payload: { message: decodeCodexErrorMessage(err?.message) } },
      ];
    }
    default:
      return [];
  }
}

/** Parses a block of JSONL text into events (no process needed). */
export function parseCodexJsonl(text: string, role: CodexRole): CodexEvent[] {
  const parser = createNdjsonParser();
  const values = [...parser.push(text.endsWith("\n") ? text : `${text}\n`)];
  return values.flatMap((v) => parseCodexLine(v, role));
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type CodexFailureKind =
  | "missing-output"
  | "invalid-json"
  | "schema-invalid"
  | "codex-error"
  | "spawn-failed"
  | "aborted";

export type CodexResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: CodexFailureKind; message: string };

/** Removes null-valued keys (the reviewer's nullable placeholders), recursively. */
function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== null) out[k] = dropNulls(v);
    }
    return out;
  }
  return value;
}

/** Reads and validates the `-o` file. Stdout prose is never used. */
export function parseCodexResult(
  role: CodexRole,
  outputFile: string,
): CodexResult<PlannerOutput | ReviewerOutput> {
  let raw: string;
  try {
    raw = fs.readFileSync(outputFile, "utf8");
  } catch {
    return { ok: false, kind: "missing-output", message: `Codex wrote no output file (${role}).` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, kind: "invalid-json", message: `Codex output for the ${role} was not JSON.` };
  }
  const candidate = role === "reviewer" ? dropNulls(json) : json;
  const parsed = (role === "planner" ? plannerOutputSchema : reviewerOutputSchema).safeParse(
    candidate,
  );
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      kind: "schema-invalid",
      message: `Codex ${role} output failed validation: ${detail}`,
    };
  }
  return { ok: true, value: parsed.data };
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

export type CodexCommandRunner = (
  file: string,
  args: string[],
  options?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: Error }>;

const defaultRunner: CodexCommandRunner = (file, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { shell: false, windowsHide: true, timeout: options.timeout ?? 15000 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: code,
          error: error ?? undefined,
        });
      },
    );
  });

export interface CodexProbeDeps {
  resolveExecutable?: typeof resolveExecutable;
  runner?: CodexCommandRunner;
  resolveOptions?: ResolveOptions;
  now?: () => number;
}

export interface CodexProbeResult extends ProbeResult {
  /** Epoch ms when this probe ran. */
  checkedAt: number;
}

export async function probeCodex(deps: CodexProbeDeps = {}): Promise<CodexProbeResult> {
  const resolve = deps.resolveExecutable ?? resolveExecutable;
  const runner = deps.runner ?? defaultRunner;
  const checkedAt = (deps.now ?? Date.now)();
  const res = resolve("codex", deps.resolveOptions);
  if (!res.ok) {
    return { installed: false, authenticated: "unknown", tried: res.tried, checkedAt };
  }

  const versionRun = await runner(res.file, [...res.prefixArgs, "--version"], { timeout: 15000 });
  if (versionRun.error && versionRun.stdout.trim() === "") {
    return {
      installed: false,
      authenticated: "unknown",
      executable: res.file,
      error: versionRun.error.message,
      checkedAt,
    };
  }
  const match = /(\d+\.\d+\.\d+[^\s]*)/.exec(versionRun.stdout);
  const version = match ? match[1] : versionRun.stdout.trim() || undefined;

  // Exit code and the command's own text decide; ~/.codex and CODEX_HOME are never read.
  const loginRun = await runner(res.file, [...res.prefixArgs, "login", "status"], {
    timeout: 15000,
  });
  const text = `${loginRun.stdout}\n${loginRun.stderr}`;
  const notLoggedIn = /not logged in/i.test(text);
  let authenticated: boolean | "unknown" = "unknown";
  if (loginRun.exitCode === 0 && !notLoggedIn) authenticated = true;
  else if (notLoggedIn || (loginRun.exitCode !== null && loginRun.exitCode !== 0 && text.trim() !== "")) {
    authenticated = false;
  }

  return { installed: true, version, authenticated, executable: res.file, checkedAt };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface RunCodexOptions extends CodexArgvOptions {
  role: CodexRole;
  prompt: string;
  /** Executable file and prefix args (from resolveExecutable). */
  file: string;
  prefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onEvent?: (event: CodexEvent) => void;
  graceMs?: number;
}

export interface CodexRunOutcome {
  result: CodexResult<PlannerOutput | ReviewerOutput>;
  sessionId?: string;
  usage?: CodexUsage;
  exit: AgentExit;
  /** Decoded error message from `error`/`turn.failed` events, if any. */
  errorMessage?: string;
}

/** Spawns Codex (shell: false), maps events, and validates the output file. */
export async function runCodex(opts: RunCodexOptions): Promise<CodexRunOutcome> {
  const { args, outputFile } = await buildCodexArgv(opts.role, opts);
  const fullArgs = [...(opts.prefixArgs ?? []), ...args];
  assertCodexArgvAllowed(fullArgs);

  // A stale file from an earlier run must never be mistaken for this result.
  fs.rmSync(outputFile, { force: true });

  let sessionId: string | undefined;
  let usage: CodexUsage | undefined;
  let errorMessage: string | undefined;

  const handle = spawnAgentProcess({
    file: opts.file,
    args: fullArgs,
    cwd: opts.worktree,
    env: opts.env,
    stdin: opts.prompt,
    onJson: (value) => {
      for (const ev of parseCodexLine(value, opts.role)) {
        const p = ev.payload as Record<string, unknown>;
        if (typeof p.sessionId === "string") sessionId = p.sessionId;
        if (p.usage) usage = p.usage as CodexUsage;
        if (ev.kind === "error" && typeof p.message === "string") errorMessage = p.message;
        opts.onEvent?.(ev);
      }
    },
  });

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void stopAgentProcess(handle, { graceMs: opts.graceMs });
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  const exit = await handle.done;
  opts.signal?.removeEventListener("abort", onAbort);

  const base = { sessionId, usage, exit, errorMessage };
  if (aborted) {
    return { ...base, result: { ok: false, kind: "aborted", message: "Codex run was stopped." } };
  }
  if (exit.error) {
    return { ...base, result: { ok: false, kind: "spawn-failed", message: exit.error } };
  }
  if (errorMessage !== undefined || (exit.code !== null && exit.code !== 0)) {
    return {
      ...base,
      result: {
        ok: false,
        kind: "codex-error",
        message: errorMessage ?? `Codex exited with code ${String(exit.code)}.`,
      },
    };
  }
  return { ...base, result: parseCodexResult(opts.role, outputFile) };
}

export const codexAdapter = {
  id: "codex",
  displayName: "Codex",
  probe: (deps?: CodexProbeDeps) => probeCodex(deps),
  buildArgv: buildCodexArgv,
  parseLine: parseCodexLine,
  parseResult: parseCodexResult,
  run: runCodex,
} as const;

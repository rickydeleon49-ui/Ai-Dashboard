/**
 * The AW.1 single-pass reviewer (design §7): one read-only `claude -p` call
 * that sees the task, the runner-computed diff summary and the check results,
 * and answers with a JSON verdict. Its output is untrusted and returned
 * unvalidated; the orchestrator validates it, so anything unusable here simply
 * becomes "no valid review".
 *
 * The CLI call is injectable so tests never start the real `claude`.
 */
import fs from "node:fs";
import nodePath from "node:path";
import { buildClaudeEnv } from "./adapters/claude-code";
import type { ReviewInput } from "./orchestrator";
import { spawnAgentProcess, stopAgentProcess } from "./process";
import { resolveExecutable } from "./resolve-executable";

export interface ClaudeCliCall {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
}

/** Runs the CLI and returns its stdout. Rejects on failure. */
export type ClaudeCliRunner = (call: ClaudeCliCall, signal: AbortSignal) => Promise<string>;

export interface ReviewDeps {
  /** Folder for the read-only grant: <runStore>/runs/<runId>/review. */
  grantDir?: string;
  runCli?: ClaudeCliRunner;
  executable?: { file: string; prefixArgs: string[] };
  baseEnv?: Record<string, string | undefined>;
  /** Overall limit for the review call (default 10 minutes). */
  timeoutMs?: number;
}

const OUTPUT_CAP = 4 * 1024 * 1024;
const TAIL_CHARS = 2048;
const MAX_DIFF_FILES = 200;

export function readOnlyGrant(): { permissions: { allow: string[]; deny: string[] } } {
  return {
    permissions: {
      allow: ["Read", "Glob", "Grep"],
      deny: ["Edit", "Write", "Bash", "WebFetch", "WebSearch"],
    },
  };
}

export function buildReviewPrompt(input: ReviewInput): string {
  const files = input.diff.files.slice(0, MAX_DIFF_FILES).map((f) => {
    const flags = [f.excluded ? "EXCLUDED PATH" : "", f.outOfScope ? "out of scope" : "", f.binary ? "binary" : ""]
      .filter(Boolean)
      .join(", ");
    return `- ${f.path} (${f.status}, +${f.additions}/-${f.deletions}${flags ? `, ${flags}` : ""})`;
  });
  const more = input.diff.files.length - files.length;
  const checks = input.checks.map((c) =>
    [
      `- ${c.name}: exit ${String(c.exitCode)}${c.timedOut ? ", TIMED OUT" : ""}`,
      "  output (last 2 KB):",
      ...c.output
        .slice(-TAIL_CHARS)
        .split("\n")
        .map((l) => `  | ${l}`),
    ].join("\n"),
  );
  return [
    "You are a code reviewer. Review the changes in your working directory against the task below.",
    "You may only read files (Read, Glob, Grep). Do not try to edit anything or run commands.",
    `The changes are everything since commit ${input.baseSha}.`,
    "",
    "## Task",
    input.task,
    "",
    "## Changed files",
    ...(files.length > 0 ? files : ["(none)"]),
    ...(more > 0 ? [`... and ${more} more`] : []),
    "",
    "## Checks run by the runner",
    ...(checks.length > 0 ? checks : ["(none)"]),
    "",
    "## Reply format",
    "Reply with ONLY a JSON object, no other text, matching exactly:",
    '{"verdict":"approve"|"request_changes","findings":[{"severity":"P1"|"P2"|"P3","path"?:string,"line"?:number,"message":string,"actionable":boolean}]}',
    "Use request_changes if the change does not do what the task asks or has a correctness problem.",
  ].join("\n");
}

/** The first top-level JSON object in `text`, tolerating ```json fences and prose around it. */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("no JSON object in the reviewer reply");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error("unterminated JSON object in the reviewer reply");
}

function makeDefaultRunCli(timeoutMs: number): ClaudeCliRunner {
  return async (call, signal) => {
    let out = "";
    let err = "";
    const handle = spawnAgentProcess({
      file: call.file,
      args: call.args,
      cwd: call.cwd,
      env: call.env as NodeJS.ProcessEnv,
      stdin: call.stdin,
      maxLineChars: OUTPUT_CAP,
      onJson: (v) => {
        if (out.length < OUTPUT_CAP) out += JSON.stringify(v) + "\n";
      },
      onText: (stream, text) => {
        if (stream === "stdout") {
          if (out.length < OUTPUT_CAP) out += text + "\n";
        } else if (err.length < 4096) err += text + "\n";
      },
    });
    const stopIt = () => {
      stopAgentProcess(handle).catch(() => {});
    };
    const timer = setTimeout(stopIt, timeoutMs);
    if (signal.aborted) stopIt();
    else signal.addEventListener("abort", stopIt, { once: true });
    try {
      const exit = await handle.done;
      if (exit.error) throw new Error(exit.error);
      if (signal.aborted) throw new Error("review stopped");
      if (exit.code !== 0) {
        throw new Error(`claude exited with code ${String(exit.code)}${err ? `: ${err.trim().slice(-500)}` : ""}`);
      }
      return out;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stopIt);
    }
  };
}

export async function reviewWithClaude(
  input: ReviewInput,
  signal: AbortSignal,
  deps: ReviewDeps = {},
): Promise<unknown> {
  try {
    if (!deps.grantDir) throw new Error("no review grant directory configured");
    fs.mkdirSync(deps.grantDir, { recursive: true });
    const grantFile = nodePath.join(deps.grantDir, "claude-review-settings.json");
    fs.writeFileSync(grantFile, JSON.stringify(readOnlyGrant(), null, 2), "utf8");

    let exe = deps.executable;
    if (!exe) {
      const res = resolveExecutable("claude");
      if (!res.ok) throw new Error("could not resolve the claude executable");
      exe = { file: res.file, prefixArgs: res.prefixArgs };
    }
    const call: ClaudeCliCall = {
      file: exe.file,
      args: [
        ...exe.prefixArgs,
        "-p",
        "--output-format",
        "json",
        "--permission-mode",
        "plan",
        "--setting-sources",
        "",
        "--settings",
        grantFile,
        "--add-dir",
        input.workspacePath,
        "--no-session-persistence",
        "--strict-mcp-config",
      ],
      cwd: input.workspacePath,
      env: buildClaudeEnv(deps.baseEnv ?? process.env),
      stdin: buildReviewPrompt(input),
    };
    const run = deps.runCli ?? makeDefaultRunCli(deps.timeoutMs ?? 10 * 60 * 1000);
    const stdout = await run(call, signal);

    let envelope: unknown;
    try {
      envelope = JSON.parse(stdout.trim());
    } catch {
      throw new Error("the claude CLI did not return a JSON envelope");
    }
    const result = (envelope as { result?: unknown } | null)?.result;
    if (typeof result !== "string") throw new Error("the claude CLI envelope has no result text");
    return extractJsonObject(result);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

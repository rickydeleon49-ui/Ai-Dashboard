/**
 * Claude Code agent adapter (§3, §6, §8, §15 step 8).
 *
 * Implements probe(), buildInvocation() with strict permission grants and no
 * bypass flags, and parses stream-json output into normalized run events.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EFFORT_LEVELS } from "../types";
import { resolveExecutable, type ResolveOptions } from "../resolve-executable";
import type {
  AgentAdapter,
  Invocation,
  InvocationRequest,
  NormalizedEvent,
  ProbeResult,
} from "./types";

/**
 * Real flags that must never appear in argv. The `--permission-mode
 * bypassPermissions` form spans two argv elements, so it is checked separately
 * in assertNoBypass (as a pair, and as the `=` form).
 */
export const DENIED_FLAGS: readonly string[] = [
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
];

const MODEL_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SHELL_META_REGEX = /[;&|`$<>(){}\r\n]/;

// Explicit allowlist (lowercase). Deliberately NOT a CLAUDE_CODE_* prefix rule:
// that would leak the parent Claude Code session's SESSION_ID, MESSAGING_*,
// ENTRYPOINT etc. into the agent.
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
  "anthropic_api_key",
  "anthropic_auth_token",
  "anthropic_base_url",
  "anthropic_custom_headers",
  "claude_config_dir",
  "claude_code_use_bedrock",
  "claude_code_use_vertex",
  "aws_region",
  "aws_profile",
  "cloud_ml_region",
  "anthropic_vertex_project_id",
  "https_proxy",
  "http_proxy",
  "no_proxy",
]);

export function assertNoBypass(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    for (const denied of DENIED_FLAGS) {
      if (arg === denied || arg.startsWith(`${denied}=`) || arg.includes(denied)) {
        throw new Error(`Denied bypass flag detected: ${arg}`);
      }
    }
    if (arg === "bypassPermissions" || arg === "--permission-mode=bypassPermissions") {
      throw new Error(`Denied bypass flag detected: ${arg}`);
    }
    if (arg === "--permission-mode" && args[i + 1] === "bypassPermissions") {
      throw new Error(`Denied bypass flag detected: --permission-mode bypassPermissions`);
    }
  }
}

export function buildClaudeEnv(
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (ALLOWED_ENV_VARS.has(key.toLowerCase())) {
      env[key] = value;
    }
  }
  return env;
}

function isPathInsideOrEqual(child: string, parent: string): boolean {
  const platform = process.platform;
  const win = platform === "win32" || platform === "darwin";
  const p = platform === "win32" ? path.win32 : path.posix;
  const normChild = win ? p.normalize(child).toLowerCase() : p.normalize(child);
  const normParent = win ? p.normalize(parent).toLowerCase() : p.normalize(parent);
  if (normChild === normParent) return true;
  const sep = platform === "win32" ? "\\" : "/";
  const prefix = normParent.endsWith(sep) ? normParent : normParent + sep;
  return normChild.startsWith(prefix);
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** Real path of `p`, or of its nearest existing ancestor with the rest re-joined. */
function realpathOfNearestAncestor(p: string): string | null {
  let current = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    const real = realpathOrNull(current);
    if (real !== null) return path.join(real, ...rest.reverse());
    const parent = path.dirname(current);
    if (parent === current) return null;
    rest.push(path.basename(current));
    current = parent;
  }
}

function assertGrantDirNotInWorkspace(
  grantDir: string,
  workspacePath: string,
): void {
  const absGrant = path.resolve(grantDir);
  const absWorkspace = path.resolve(workspacePath);
  const fail = () =>
    new Error(
      `grantDir cannot be inside workspacePath: ${grantDir} is inside ${workspacePath}`,
    );
  if (isPathInsideOrEqual(absGrant, absWorkspace)) throw fail();

  // Resolve junctions/symlinks. Lookups may fail (missing paths) and are
  // swallowed inside the helpers; the comparison and throw happen out here.
  const realGrant = realpathOfNearestAncestor(absGrant);
  const realWorkspace = realpathOfNearestAncestor(absWorkspace);
  if (
    realGrant !== null &&
    realWorkspace !== null &&
    isPathInsideOrEqual(realGrant, realWorkspace)
  ) {
    throw fail();
  }
}

export type CommandRunner = (
  file: string,
  args: string[],
  options?: { timeout?: number; env?: Record<string, string> },
) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: Error;
}>;

function defaultExecFile(
  file: string,
  args: string[],
  options: { timeout?: number; env?: Record<string, string> } = {},
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: Error;
}> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        shell: false,
        windowsHide: true,
        timeout: options.timeout ?? 15000,
        env: options.env as NodeJS.ProcessEnv | undefined,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode:
            error &&
            "code" in error &&
            typeof (error as { code: unknown }).code === "number"
              ? ((error as { code: number }).code as number)
              : error
                ? 1
                : 0,
          error: error ?? undefined,
        });
      },
    );
  });
}

export interface ClaudeProbeDeps {
  resolveExecutable?: typeof resolveExecutable;
  runner?: CommandRunner;
  resolveOptions?: ResolveOptions;
}

export async function probeClaudeCode(
  deps: ClaudeProbeDeps = {},
): Promise<ProbeResult> {
  const resolve = deps.resolveExecutable ?? resolveExecutable;
  const runner = deps.runner ?? defaultExecFile;
  const res = resolve("claude", deps.resolveOptions);

  if (!res.ok) {
    return {
      installed: false,
      authenticated: "unknown",
      tried: res.tried,
    };
  }

  // 1. Version check
  let version: string | undefined;
  const versionRun = await runner(
    res.file,
    [...res.prefixArgs, "--version"],
    { timeout: 15000 },
  );

  if (versionRun.error && versionRun.stdout.trim() === "") {
    return {
      installed: false,
      authenticated: "unknown",
      executable: res.file,
      error: versionRun.error.message,
    };
  }

  const verMatch = /(\d+\.\d+\.\d+[^\s]*)/.exec(versionRun.stdout);
  version = verMatch ? verMatch[1] : versionRun.stdout.trim() || undefined;

  // 2. Auth status check
  let authenticated: boolean | "unknown" = "unknown";
  const authRun = await runner(
    res.file,
    [...res.prefixArgs, "auth", "status", "--json"],
    { timeout: 15000 },
  );

  if (authRun.stdout.trim()) {
    try {
      const parsed = JSON.parse(authRun.stdout);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "loggedIn" in parsed &&
        typeof (parsed as { loggedIn: unknown }).loggedIn === "boolean"
      ) {
        authenticated = (parsed as { loggedIn: boolean }).loggedIn;
      }
    } catch {
      authenticated = "unknown";
    }
  }

  return {
    installed: true,
    version,
    authenticated,
    executable: res.file,
  };
}

export interface ClaudeInvocationDeps {
  resolveExecutable?: typeof resolveExecutable;
  baseEnv?: Record<string, string | undefined>;
  executableFile?: string;
  prefixArgs?: string[];
}

export function buildClaudeInvocation(
  req: InvocationRequest,
  deps: ClaudeInvocationDeps = {},
): Invocation {
  assertGrantDirNotInWorkspace(req.grantDir, req.workspacePath);

  if (req.model !== undefined && !MODEL_REGEX.test(req.model)) {
    throw new Error(`Invalid model name: ${req.model}`);
  }
  if (
    req.effort !== undefined &&
    !(EFFORT_LEVELS as readonly string[]).includes(String(req.effort))
  ) {
    throw new Error(`Invalid effort level: ${String(req.effort)}`);
  }

  // Validate check commands and build permissions.allow
  const allow: string[] = [
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
    ...req.checkCommands.map((cmd) => {
      for (const arg of cmd) {
        if (SHELL_META_REGEX.test(arg)) {
          throw new Error(
            `Check command contains forbidden shell metacharacter: ${arg}`,
          );
        }
      }
      return `Bash(${cmd.join(" ")})`;
    }),
  ];

  // Build permissions.deny
  const deny: string[] = [
    "Bash(git push:*)",
    "Bash(git merge:*)",
    "Bash(git remote:*)",
    "Bash(npm publish:*)",
    "Bash(curl:*)",
    "Bash(wget:*)",
    "WebFetch",
    "WebSearch",
  ];
  for (const excluded of req.excludedPaths) {
    deny.push(`Read(${excluded})`, `Edit(${excluded})`, `Write(${excluded})`);
  }

  // Create grant directory and write claude-settings.json
  fs.mkdirSync(req.grantDir, { recursive: true });
  const grantFile = path.join(req.grantDir, "claude-settings.json");
  fs.writeFileSync(
    grantFile,
    JSON.stringify({ permissions: { allow, deny } }, null, 2),
    "utf8",
  );

  // Resolve executable
  let file = deps.executableFile;
  let prefixArgs = deps.prefixArgs ?? [];
  if (!file) {
    const resolve = deps.resolveExecutable ?? resolveExecutable;
    const res = resolve("claude");
    if (res.ok) {
      file = res.file;
      prefixArgs = res.prefixArgs;
    } else {
      throw new Error(
        `Could not resolve the claude executable. Tried: ${res.tried.join(", ")}`,
      );
    }
  }

  // Construct argv in exact required order
  const args = [
    ...prefixArgs,
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--permission-mode",
    "default",
    // Empty value is accepted by claude (verified on 2.1.312): it loads no
    // user/project/local settings, so they cannot widen the grant file.
    "--setting-sources",
    "",
    "--settings",
    grantFile,
    "--add-dir",
    req.workspacePath,
    "--no-session-persistence",
    "--strict-mcp-config",
  ];

  if (req.model) {
    args.push("--model", req.model);
  }
  if (req.effort) {
    args.push("--effort", String(req.effort));
  }
  if (req.resumeSessionId && UUID_REGEX.test(req.resumeSessionId)) {
    args.push("--resume", req.resumeSessionId);
  }

  // Assert no bypass flags present anywhere in the generated argv
  assertNoBypass(args);

  const env = buildClaudeEnv(deps.baseEnv ?? process.env);

  return {
    file,
    args,
    cwd: req.workspacePath,
    env,
    stdin: req.prompt,
    grantFile,
  };
}

export function parseClaudeLine(obj: unknown): NormalizedEvent[] {
  if (obj === null || typeof obj !== "object") {
    return [];
  }

  const record = obj as Record<string, unknown>;

  // system / init
  if (record.type === "system" && record.subtype === "init") {
    return [
      {
        agent: "implementer",
        kind: "output",
        payload: {
          sessionId:
            (record.session_id as string | undefined) ??
            (record.sessionId as string | undefined),
          model: record.model,
        },
      },
    ];
  }

  // assistant
  if (record.type === "assistant") {
    const events: NormalizedEvent[] = [];
    const msg = record.message as { content?: unknown[] } | undefined;
    const content = Array.isArray(msg?.content)
      ? msg.content
      : Array.isArray(record.content)
        ? record.content
        : [];

    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          events.push({
            agent: "implementer",
            kind: "output",
            payload: { text: b.text },
          });
        } else if (b.type === "tool_use") {
          events.push({
            agent: "implementer",
            kind: "tool_call",
            payload: {
              id: b.id,
              name: b.name,
              input: b.input,
            },
          });
        }
      }
    }
    return events;
  }

  // user
  if (record.type === "user") {
    const events: NormalizedEvent[] = [];
    const msg = record.message as { content?: unknown[] } | undefined;
    const content = Array.isArray(msg?.content)
      ? msg.content
      : Array.isArray(record.content)
        ? record.content
        : [];

    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result") {
          let text =
            typeof b.content === "string"
              ? b.content
              : b.content !== undefined
                ? JSON.stringify(b.content)
                : "";
          if (text.length > 4000) {
            text = text.slice(0, 4000);
          }
          events.push({
            agent: "implementer",
            kind: "tool_result",
            payload: {
              toolUseId:
                (b.tool_use_id as string | undefined) ??
                (b.toolUseId as string | undefined),
              isError: Boolean(b.is_error ?? b.isError),
              content: text,
            },
          });
        }
      }
    }
    return events;
  }

  // result
  if (record.type === "result") {
    const text =
      typeof record.result === "string"
        ? record.result
        : typeof record.text === "string"
          ? record.text
          : "";

    return [
      {
        agent: "implementer",
        kind: "output",
        payload: {
          final: true,
          isError: Boolean(record.is_error ?? record.isError),
          subtype: record.subtype,
          sessionId:
            (record.session_id as string | undefined) ??
            (record.sessionId as string | undefined),
          numTurns:
            (record.num_turns as number | undefined) ??
            (record.numTurns as number | undefined),
          durationMs:
            (record.duration_ms as number | undefined) ??
            (record.durationMs as number | undefined),
          costUsd:
            (record.total_cost_usd as number | undefined) ??
            (record.costUsd as number | undefined),
          text,
        },
      },
    ];
  }

  return [];
}

export const claudeAdapter: AgentAdapter = {
  id: "claude-code",
  displayName: "Claude Code",
  probe: (deps?: unknown) => probeClaudeCode(deps as ClaudeProbeDeps | undefined),
  buildInvocation: (req: InvocationRequest) => buildClaudeInvocation(req),
  parseLine: (obj: unknown) => parseClaudeLine(obj),
};

export const claudeCodeAdapter = claudeAdapter;

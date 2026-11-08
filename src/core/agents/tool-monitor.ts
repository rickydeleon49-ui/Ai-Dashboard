import fs from "node:fs";
import nodePath from "node:path";

/**
 * Antigravity tool monitor (AW3-03). Antigravity runs with its own tools, so
 * the only enforcement we have is to watch the step events it streams and kill
 * the process group on the first tool call that leaves the worktree or uses a
 * tool outside the allowlist. Every doubt is a denial.
 */

/** Both naming sets: agy 1.5.3 step events differ from its init tool list. */
export const ANTIGRAVITY_TOOL_ALLOWLIST: readonly string[] = Object.freeze([
  "view_file",
  "read_file",
  "list_dir",
  "grep_search",
  "find_by_name",
  "write_to_file",
  "write_file",
  "replace_file_content",
  "multi_replace_file_content",
  "finish",
]);

const ALLOWED_TOOLS: ReadonlySet<string> = new Set(ANTIGRAVITY_TOOL_ALLOWLIST);
const PLUGIN_READ_TOOLS: ReadonlySet<string> = new Set(["read_file", "view_file"]);
const PLUGIN_FILE_NAME = "SKILL.md";

const EXPLICIT_PATH_KEYS = new Set(
  [
    "Path",
    "AbsolutePath",
    "TargetFile",
    "DirectoryPath",
    "SearchPath",
    "SearchDirectory",
    "File",
  ].map((k) => k.toLowerCase()),
);
const PATH_KEY_SUFFIX = /(path|file|directory)$/i;

export type MonitorDecision =
  | { allowed: true; pluginRead?: true; tool: string; paths: string[] }
  | { allowed: false; tool: string; path?: string; reason: string };

export interface ToolMonitorOptions {
  worktree: string;
  /** Home directory used for the plugin SKILL.md exception. */
  home?: string;
  platform?: NodeJS.Platform;
  realpath?: (p: string) => Promise<string>;
  /**
   * Used to detect a dangling symlink at the first missing path component.
   * Defaults to fs.readlink only when realpath is not injected.
   */
  readlink?: (p: string) => Promise<string>;
}

class Deny extends Error {
  constructor(
    readonly reason: string,
    readonly path?: string,
  ) {
    super(reason);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPathKey(key: string): boolean {
  return EXPLICIT_PATH_KEYS.has(key.toLowerCase()) || PATH_KEY_SUFFIX.test(key);
}

function errCode(err: unknown): string | undefined {
  return isRecord(err) && typeof err.code === "string" ? err.code : undefined;
}

export class ToolMonitor {
  private readonly platform: NodeJS.Platform;
  private readonly p: nodePath.PlatformPath;
  private readonly realpathFn: (p: string) => Promise<string>;
  private readonly readlinkFn?: (p: string) => Promise<string>;
  private readonly worktree: string;
  private readonly home: string | undefined;
  private worktreeReal?: Promise<string>;
  private pluginsReal?: Promise<string | undefined>;

  constructor(opts: ToolMonitorOptions) {
    this.platform = opts.platform ?? process.platform;
    this.p = this.platform === "win32" ? nodePath.win32 : nodePath.posix;
    this.realpathFn = opts.realpath ?? ((x) => fs.promises.realpath(x));
    this.readlinkFn = opts.readlink ?? (opts.realpath ? undefined : (x) => fs.promises.readlink(x));
    this.worktree = opts.worktree;
    this.home = opts.home;
  }

  /** Accepts the raw `step_update` object. Safe to call for every state of a step. */
  async check(step: unknown): Promise<MonitorDecision> {
    if (!isRecord(step)) return { allowed: false, tool: "", reason: "malformed step" };
    const info = isRecord(step.tool_info) ? step.tool_info : undefined;
    const isTool = step.step_type === "tool" || step.tool_name !== undefined || info !== undefined;
    if (!isTool) return { allowed: true, tool: "", paths: [] };

    const nameA = typeof step.tool_name === "string" ? step.tool_name : undefined;
    const nameB = info && typeof info.name === "string" ? info.name : undefined;
    if (nameA !== undefined && nameB !== undefined && nameA !== nameB) {
      return { allowed: false, tool: nameA, reason: "tool name mismatch" };
    }
    const tool = nameA ?? nameB ?? "";
    if (!ALLOWED_TOOLS.has(tool)) {
      return { allowed: false, tool, reason: "tool not allowed" };
    }

    try {
      const raw = this.collectPaths(info?.parameters);
      const resolved: string[] = [];
      let pluginRead = false;
      for (const candidate of raw) {
        const real = await this.resolveReal(candidate);
        if (await this.insideWorktree(real)) {
          resolved.push(real);
          continue;
        }
        if (await this.isPluginSkillRead(tool, candidate, real)) {
          pluginRead = true;
          resolved.push(real);
          continue;
        }
        throw new Deny("path outside worktree", candidate);
      }
      return pluginRead
        ? { allowed: true, pluginRead: true, tool, paths: resolved }
        : { allowed: true, tool, paths: resolved };
    } catch (err) {
      if (err instanceof Deny) {
        return { allowed: false, tool, path: err.path, reason: err.reason };
      }
      return { allowed: false, tool, reason: "path check failed" };
    }
  }

  private collectPaths(params: unknown): string[] {
    if (params === undefined || params === null) return [];
    if (!isRecord(params)) throw new Deny("malformed tool parameters");
    const out: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (!isPathKey(key)) continue;
      if (value === undefined || value === null) continue;
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        if (typeof item !== "string") throw new Deny(`non-string path parameter ${key}`);
        if (item === "" || item.includes("\0")) {
          throw new Deny(`invalid path parameter ${key}`, item);
        }
        out.push(item);
      }
    }
    return out;
  }

  private fold(s: string): string {
    return this.platform === "win32" ? s.toLowerCase() : s;
  }

  private async resolveWorktree(): Promise<string> {
    this.worktreeReal ??= (async () => {
      const abs = this.p.resolve(this.worktree);
      return this.p.resolve(await this.realpathFn(abs));
    })();
    return this.worktreeReal;
  }

  /** Resolve against the worktree, then realpath the nearest existing ancestor. */
  private async resolveReal(input: string): Promise<string> {
    const root = await this.resolveWorktree();
    return this.realpathOf(this.p.resolve(root, input));
  }

  private async realpathOf(abs: string): Promise<string> {
    const rest: string[] = [];
    let cur = abs;
    for (;;) {
      try {
        const real = this.p.resolve(await this.realpathFn(cur));
        return rest.length ? this.p.join(real, ...rest.reverse()) : real;
      } catch (err) {
        const code = errCode(err);
        if (code !== "ENOENT" && code !== "ENOTDIR") throw new Deny("cannot resolve path", abs);
        if (this.readlinkFn) {
          let isLink = true;
          try {
            await this.readlinkFn(cur);
          } catch (e) {
            const c = errCode(e);
            // Not a symlink (EINVAL) or missing (ENOENT/ENOTDIR): safe to keep walking up.
            isLink = !(c === "EINVAL" || c === "ENOENT" || c === "ENOTDIR");
          }
          if (isLink) throw new Deny("dangling or unreadable symlink", abs);
        }
        const parent = this.p.dirname(cur);
        if (parent === cur) throw new Deny("cannot resolve path", abs);
        rest.push(this.p.basename(cur));
        cur = parent;
      }
    }
  }

  private isInside(root: string, target: string): boolean {
    const r = this.fold(root);
    const t = this.fold(target);
    if (t === r) return true;
    const prefix = r.endsWith(this.p.sep) ? r : r + this.p.sep;
    return t.startsWith(prefix);
  }

  private async insideWorktree(real: string): Promise<boolean> {
    return this.isInside(await this.resolveWorktree(), real);
  }

  private async resolvePlugins(): Promise<string | undefined> {
    this.pluginsReal ??= (async () => {
      if (!this.home) return undefined;
      const dir = this.p.resolve(this.home, ".gemini", "config", "plugins");
      try {
        return await this.realpathOf(dir);
      } catch {
        return undefined;
      }
    })();
    return this.pluginsReal;
  }

  private async isPluginSkillRead(tool: string, requested: string, real: string): Promise<boolean> {
    if (!PLUGIN_READ_TOOLS.has(tool)) return false;
    const plugins = await this.resolvePlugins();
    if (!plugins) return false;
    const want = this.fold(PLUGIN_FILE_NAME);
    // Both the requested name and the resolved target must be exactly SKILL.md.
    if (this.fold(this.p.basename(requested)) !== want) return false;
    if (this.fold(this.p.basename(real)) !== want) return false;
    // Strictly inside the plugins folder (the folder itself is not a file).
    return this.fold(real) !== this.fold(plugins) && this.isInside(plugins, real);
  }
}

/** One line naming the tool and path, for the run failure message. */
export function describeViolation(decision: MonitorDecision): string {
  if (decision.allowed) return "";
  const clean = (s: string) => s.replace(/[\r\n\t]+/g, " ").slice(0, 300);
  const tool = decision.tool ? clean(decision.tool) : "(unnamed tool)";
  const where = decision.path !== undefined ? ` on ${clean(decision.path)}` : "";
  return `Antigravity tool ${tool}${where} blocked: ${decision.reason}`;
}

const killed = new WeakSet<() => void>();

/**
 * Calls `kill` exactly once, on the first violation seen for that `kill`
 * function. Returns true when this call performed the kill.
 */
export function stopOnViolation(decision: MonitorDecision, kill: () => void): boolean {
  if (decision.allowed || killed.has(kill)) return false;
  killed.add(kill);
  kill();
  return true;
}

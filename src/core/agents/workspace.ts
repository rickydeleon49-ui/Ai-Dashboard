/**
 * Worktree lifecycle, runner stage commits and diff summary for the
 * Agent Workflow Control Center (§5, §5A, §10A, §15 step 6).
 *
 * All git calls go through execGit(), using resolveExecutable("git") with
 * shell: false, argv arrays, explicit cwd, windowsHide: true, a timeout, and
 * GIT_TERMINAL_PROMPT=0. Command strings are never constructed.
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { promisify } from "node:util";
import { unlinkDependencies } from "./dependency-links";
import { normalizeForCompare } from "./roots";
import { resolveExecutable } from "./resolve-executable";
import { redactText } from "./redact";
import { RUN_STAGES } from "./types";

const execFileAsync = promisify(execFile);

const DEFAULT_GIT_TIMEOUT_MS = 60_000;

export interface GitExecOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
}

/** Error carrying git's exit code and captured output. */
export class GitError extends Error {
  readonly code: number | string | undefined;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    message: string,
    code: number | string | undefined,
    stdout: string,
    stderr: string,
  ) {
    super(message);
    this.name = "GitError";
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

let emptyHooksDir: string | null = null;

/**
 * An empty directory the runner owns, used as core.hooksPath so repository
 * hooks (which could run agent-written code) can never execute. It lives
 * under os.tmpdir(), is created once and is never written to.
 */
function getEmptyHooksDir(): string {
  if (emptyHooksDir === null || !fs.existsSync(emptyHooksDir)) {
    const dir = nodePath.join(os.tmpdir(), "command-center-empty-hooks");
    fs.mkdirSync(dir, { recursive: true });
    emptyHooksDir = dir;
  }
  return emptyHooksDir;
}

/**
 * Config options prepended to every git call. They are passed with -c, so
 * nothing is ever stored in the user's repository config:
 * - core.fsmonitor=false: a repo-configured fsmonitor program never runs.
 * - core.hooksPath=<empty dir>: repo hooks never run.
 * - core.longpaths=true on Windows.
 */
function hardeningConfigArgs(): string[] {
  const args = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${getEmptyHooksDir()}`,
  ];
  if (process.platform === "win32") {
    args.push("-c", "core.longpaths=true");
  }
  return args;
}

/**
 * The single internal helper through which all git invocations are routed.
 * Shell is always false, argv arrays only, cwd explicit, windowsHide true.
 */
export async function execGit(
  args: string[],
  options: GitExecOptions,
): Promise<GitExecResult> {
  const resolved = resolveExecutable("git");
  if (!resolved.ok) {
    throw new Error(
      `Failed to resolve git executable. Tried: ${resolved.tried.join(", ")}`,
    );
  }

  const allArgs = [...resolved.prefixArgs, ...hardeningConfigArgs(), ...args];
  const timeout = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;

  try {
    const result = await execFileAsync(resolved.file, allArgs, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        GIT_TERMINAL_PROMPT: "0",
      },
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout,
      maxBuffer: 20 * 1024 * 1024,
    });

    return { stdout: result.stdout, stderr: result.stderr };
  } catch (err: unknown) {
    const e = err as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const stdout = typeof e?.stdout === "string" ? e.stdout : "";
    const stderr = typeof e?.stderr === "string" ? e.stderr : "";
    const verb =
      args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? "";
    const message = `git ${verb} failed (exit ${e?.code ?? "unknown"}): ${
      stderr.trim() || stdout.trim() || e?.message || String(err)
    }`;
    throw new GitError(message, e?.code, stdout, stderr);
  }
}

/**
 * Returns true if repoPath is inside an existing git work tree.
 */
export async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    const res = await execGit(["rev-parse", "--is-inside-work-tree"], {
      cwd: repoPath,
    });
    return res.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Derive a short, deterministic, filesystem-safe identifier (12 hex characters)
 * from a run ID.
 */
export function shortRunId(runId: string): string {
  if (typeof runId !== "string" || runId.trim() === "") {
    throw new Error("runId must be a non-empty string");
  }
  const clean = runId.trim();
  const hexOnly = clean.replace(/-/g, "");
  if (/^[0-9a-fA-F]{12,}$/.test(hexOnly)) {
    return hexOnly.slice(0, 12).toLowerCase();
  }
  return crypto.createHash("sha256").update(clean).digest("hex").slice(0, 12);
}

/**
 * Path for an agent run worktree: `<worktreeRoot>/command-center/<shortId>`.
 * Command Center uses its own subfolder and never touches anything else.
 */
export function worktreePathFor(worktreeRoot: string, runId: string): string {
  if (typeof worktreeRoot !== "string" || worktreeRoot.trim() === "") {
    throw new Error("worktreeRoot must be a non-empty string");
  }
  const shortId = shortRunId(runId);
  return nodePath.join(worktreeRoot, "command-center", shortId);
}

export interface CreateRunWorktreeOptions {
  repoPath: string;
  worktreeRoot: string;
  runId: string;
  baseRef?: string;
}

export interface CreateRunWorktreeResult {
  path: string;
  branch: string;
  baseSha: string;
}

/**
 * baseRef goes into argv, so it must not be usable as an option or contain
 * revision syntax beyond a plain ref name: HEAD, a hex sha, or
 * [A-Za-z0-9._/-]+ not starting with "-" and without "..".
 */
export function assertSafeBaseRef(baseRef: string): void {
  const ok =
    typeof baseRef === "string" &&
    baseRef !== "" &&
    !baseRef.startsWith("-") &&
    !baseRef.includes("..") &&
    (baseRef === "HEAD" ||
      /^[0-9a-f]{7,64}$/.test(baseRef) ||
      /^[A-Za-z0-9._/-]+$/.test(baseRef));
  if (!ok) {
    throw new Error(`Unsafe or invalid baseRef: ${JSON.stringify(baseRef)}`);
  }
}

/** baseSha goes into argv, so it must be a plain lowercase hex object id. */
export function assertSafeBaseSha(baseSha: string): void {
  if (typeof baseSha !== "string" || !/^[0-9a-f]{7,64}$/.test(baseSha)) {
    throw new Error(`Invalid baseSha: ${JSON.stringify(baseSha)}`);
  }
}

export type CreateWorktreeOptions = CreateRunWorktreeOptions;
export type CreateWorktreeResult = CreateRunWorktreeResult;

/**
 * Creates a git worktree for a run under `<worktreeRoot>/command-center/<shortId>`.
 * Never writes repository config (worktrees share the main repo's .git/config);
 * core.longpaths is passed per call by execGit instead.
 * Never touches the user's checkout, index or uncommitted work.
 */
export async function createRunWorktree(
  options: CreateRunWorktreeOptions,
): Promise<CreateRunWorktreeResult> {
  const { repoPath, worktreeRoot, runId, baseRef = "HEAD" } = options;

  if (typeof repoPath !== "string" || repoPath.trim() === "") {
    throw new Error("repoPath must be a non-empty string");
  }
  if (typeof worktreeRoot !== "string" || worktreeRoot.trim() === "") {
    throw new Error("worktreeRoot must be a non-empty string");
  }

  assertSafeBaseRef(baseRef);

  const isRepo = await isGitRepo(repoPath);
  if (!isRepo) {
    throw new Error(`Path is not a git repository: ${repoPath}`);
  }

  const shortId = shortRunId(runId);
  const targetPath = worktreePathFor(worktreeRoot, runId);
  const branch = `agent/${shortId}`;

  // Ensure command-center directory exists inside worktreeRoot
  const commandCenterDir = nodePath.join(worktreeRoot, "command-center");
  fs.mkdirSync(commandCenterDir, { recursive: true });

  // Add worktree on new branch agent/<shortId> at baseRef
  await execGit(
    ["worktree", "add", "-b", branch, targetPath, baseRef],
    { cwd: repoPath },
  );

  // Resolve base commit SHA in the newly created worktree
  const rev = await execGit(["rev-parse", "HEAD"], {
    cwd: targetPath,
  });
  const baseSha = rev.stdout.trim();

  return {
    path: targetPath,
    branch,
    baseSha,
  };
}

/**
 * Stages everything (`git add -A`) in the worktree, and if there are changes,
 * creates a runner-authored commit `agent(<runShortId>): <stage>` using the
 * fixed identity `Command Center Runner <runner@command-center.local>`.
 * Uses `--no-verify` so repository hooks never execute agent code.
 * Returns the new commit SHA, or null when nothing was staged.
 */
export async function commitStage(
  worktreePath: string,
  stage: string,
  runShortId: string,
): Promise<string | null> {
  if (typeof worktreePath !== "string" || worktreePath.trim() === "") {
    throw new Error("worktreePath must be a non-empty string");
  }
  if (
    typeof stage !== "string" ||
    !(stage === "stopped" || (RUN_STAGES as readonly string[]).includes(stage))
  ) {
    throw new Error(`Invalid stage: ${JSON.stringify(stage)}`);
  }
  if (typeof runShortId !== "string" || !/^[0-9a-f]{12}$/.test(runShortId)) {
    throw new Error(`Invalid runShortId: ${JSON.stringify(runShortId)}`);
  }

  // Stage everything: git add -A
  await execGit(["add", "-A"], { cwd: worktreePath });

  // Check if anything is staged
  const status = await execGit(["status", "--porcelain"], {
    cwd: worktreePath,
  });
  if (status.stdout.trim() === "") {
    return null;
  }

  const commitMsg = `agent(${runShortId}): ${stage}`;

  await execGit(
    [
      "-c",
      "user.name=Command Center Runner",
      "-c",
      "user.email=runner@command-center.local",
      "commit",
      "--no-verify",
      "-m",
      commitMsg,
    ],
    {
      cwd: worktreePath,
      env: {
        GIT_AUTHOR_NAME: "Command Center Runner",
        GIT_AUTHOR_EMAIL: "runner@command-center.local",
        GIT_COMMITTER_NAME: "Command Center Runner",
        GIT_COMMITTER_EMAIL: "runner@command-center.local",
      },
    },
  );

  const rev = await execGit(["rev-parse", "HEAD"], { cwd: worktreePath });
  return rev.stdout.trim();
}

/* ------------------------------------------------------------------ */
/* Glob matcher & scoping for diffSummary                              */
/* ------------------------------------------------------------------ */

/**
 * Convert a glob pattern containing **, *, and ? to a RegExp.
 */
export function globToRegex(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, "/");
  let reStr = "";
  let i = 0;
  while (i < normalized.length) {
    const c = normalized[i];
    if (c === "*") {
      if (normalized[i + 1] === "*") {
        i += 2;
        if (normalized[i] === "/") {
          i++;
          reStr += "(?:.*/)?";
        } else if (i === normalized.length) {
          if (reStr.endsWith("/")) {
            reStr = reStr.slice(0, -1) + "(?:/.*)?";
          } else {
            reStr += ".*";
          }
        } else {
          reStr += ".*";
        }
      } else {
        i++;
        reStr += "[^/]*";
      }
    } else if (c === "?") {
      i++;
      reStr += "[^/]";
    } else if (
      c === "." ||
      c === "+" ||
      c === "(" ||
      c === ")" ||
      c === "[" ||
      c === "]" ||
      c === "{" ||
      c === "}" ||
      c === "^" ||
      c === "$" ||
      c === "|" ||
      c === "\\"
    ) {
      reStr += "\\" + c;
      i++;
    } else {
      reStr += c;
      i++;
    }
  }
  return new RegExp(`^${reStr}$`);
}

/**
 * Match a file path against a glob pattern. If the pattern contains no slash,
 * matches against both the full path and the file's basename.
 */
export function matchGlob(glob: string, filePath: string): boolean {
  const normPath = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const normGlob = glob.replace(/\\/g, "/").replace(/^\/+/, "");
  const re = globToRegex(normGlob);
  if (re.test(normPath)) return true;
  if (!normGlob.includes("/")) {
    const base = normPath.slice(normPath.lastIndexOf("/") + 1);
    if (re.test(base)) return true;
  }
  return false;
}

/**
 * Check whether a file path is in scope per scopePaths.
 * scopePaths empty => everything is in scope (outOfScope = false).
 * scopePaths non-empty => path matches itself or anything under it.
 */
export function isPathInScope(filePath: string, scopePaths: string[]): boolean {
  if (!scopePaths || scopePaths.length === 0) {
    return true;
  }
  const normFile = filePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return scopePaths.some((scope) => {
    const normScope = scope.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!normScope || normScope === ".") return true;
    if (/[*?]/.test(normScope)) return matchGlob(normScope, normFile);
    return normFile === normScope || normFile.startsWith(normScope + "/");
  });
}

function isFileExcluded(
  path: string,
  oldPath: string | undefined,
  excludedPaths: string[],
): boolean {
  if (!excludedPaths || excludedPaths.length === 0) return false;
  return excludedPaths.some(
    (pattern) =>
      matchGlob(pattern, path) ||
      (oldPath ? matchGlob(pattern, oldPath) : false),
  );
}

function getDirectory(filePath: string): string {
  const norm = filePath.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? "" : norm.slice(0, idx);
}

/* ------------------------------------------------------------------ */
/* diffSummary                                                         */
/* ------------------------------------------------------------------ */

export type DiffFileStatus = "added" | "deleted" | "modified" | "renamed";

export interface DiffSummaryFile {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  outOfScope: boolean;
  excluded: boolean;
}

export interface DiffSummaryTotals {
  files: number;
  additions: number;
  deletions: number;
}

export interface DiffSummaryResult {
  files: DiffSummaryFile[];
  totals: DiffSummaryTotals;
}

export interface DiffSummaryOptions {
  excludedPaths?: string[];
  scopePaths?: string[];
}

/**
 * Computes a diff summary between baseSha and HEAD in the given worktree.
 * Uses --numstat -z -M --ignore-cr-at-eol and --name-status -z.
 * Orders files for review:
 *   1. excluded or outOfScope files first;
 *   2. then grouped by directory;
 *   3. within each directory, by lines changed descending.
 */
export async function diffSummary(
  worktreePath: string,
  baseSha: string,
  options: DiffSummaryOptions = {},
): Promise<DiffSummaryResult> {
  const { excludedPaths = [], scopePaths = [] } = options;
  assertSafeBaseSha(baseSha);
  const diffRange = `${baseSha}...HEAD`;

  // 1. git diff --name-status -z -M --ignore-cr-at-eol <baseSha>...HEAD
  const nameStatusRes = await execGit(
    ["diff", "--name-status", "-z", "-M", "--ignore-cr-at-eol", diffRange],
    { cwd: worktreePath },
  );

  // 2. git diff --numstat -z -M --ignore-cr-at-eol <baseSha>...HEAD
  const numstatRes = await execGit(
    ["diff", "--numstat", "-z", "-M", "--ignore-cr-at-eol", diffRange],
    { cwd: worktreePath },
  );

  // Parse --name-status records
  interface StatusRecord {
    status: DiffFileStatus;
    path: string;
    oldPath?: string;
  }
  const statusRecords: StatusRecord[] = [];
  const statusTokens = nameStatusRes.stdout.split("\0");
  let si = 0;
  while (si < statusTokens.length) {
    const code = statusTokens[si++];
    if (!code) break;
    if (code.startsWith("R") || code.startsWith("C")) {
      const oldPath = statusTokens[si++];
      const path = statusTokens[si++];
      if (!path || !oldPath) break;
      statusRecords.push({
        status: code.startsWith("R") ? "renamed" : "added",
        oldPath,
        path,
      });
    } else {
      const path = statusTokens[si++];
      if (!path) break;
      let status: DiffFileStatus = "modified";
      if (code.startsWith("A")) status = "added";
      else if (code.startsWith("D")) status = "deleted";
      statusRecords.push({ status, path });
    }
  }

  // Parse --numstat records
  interface NumstatRecord {
    path: string;
    oldPath?: string;
    additions: number;
    deletions: number;
    binary: boolean;
  }
  const numstatMap = new Map<string, NumstatRecord>();
  const numstatTokens = numstatRes.stdout.split("\0");
  let ni = 0;
  while (ni < numstatTokens.length) {
    const rawLine = numstatTokens[ni] ?? "";
    if (!rawLine && ni === numstatTokens.length - 1) break;
    const parts = rawLine.split("\t");
    if (parts.length >= 3) {
      const addStr = parts[0] ?? "";
      const delStr = parts[1] ?? "";
      const maybePath = parts.slice(2).join("\t");
      let path = "";
      let oldPath: string | undefined = undefined;
      if (maybePath === "") {
        oldPath = numstatTokens[++ni] ?? "";
        path = numstatTokens[++ni] ?? "";
      } else {
        path = maybePath;
      }
      const isBinary = addStr === "-" || delStr === "-";
      const additions = isBinary ? 0 : parseInt(addStr, 10) || 0;
      const deletions = isBinary ? 0 : parseInt(delStr, 10) || 0;
      numstatMap.set(path, {
        path,
        oldPath,
        additions,
        deletions,
        binary: isBinary,
      });
    }
    ni++;
  }

  // Combine into diff entries
  const files: DiffSummaryFile[] = [];
  for (const sr of statusRecords) {
    const num = numstatMap.get(sr.path);
    const additions = num ? num.additions : 0;
    const deletions = num ? num.deletions : 0;
    const binary = num ? num.binary : false;

    const excluded = isFileExcluded(sr.path, sr.oldPath, excludedPaths);
    const outOfScope =
      scopePaths.length > 0 && !isPathInScope(sr.path, scopePaths);

    const fileEntry: DiffSummaryFile = {
      path: sr.path,
      ...(sr.oldPath ? { oldPath: sr.oldPath } : {}),
      status: sr.status,
      additions,
      deletions,
      binary,
      outOfScope,
      excluded,
    };
    files.push(fileEntry);
  }

  // Sort files:
  // 1. excluded or outOfScope first;
  // 2. then grouped by directory;
  // 3. within a group, by lines changed descending.
  files.sort((a, b) => {
    const aFlagged = a.excluded || a.outOfScope;
    const bFlagged = b.excluded || b.outOfScope;
    if (aFlagged !== bFlagged) {
      return aFlagged ? -1 : 1;
    }

    const dirA = getDirectory(a.path);
    const dirB = getDirectory(b.path);
    if (dirA !== dirB) {
      return dirA.localeCompare(dirB);
    }

    const linesA = a.additions + a.deletions;
    const linesB = b.additions + b.deletions;
    if (linesA !== linesB) {
      return linesB - linesA;
    }

    return a.path.localeCompare(b.path);
  });

  const totals: DiffSummaryTotals = {
    files: files.length,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
  };

  return { files, totals };
}

/* ------------------------------------------------------------------ */
/* diffPatch                                                           */
/* ------------------------------------------------------------------ */

/** Per-file cap on stored patch text (UTF-8 bytes). */
export const DIFF_PATCH_FILE_CAP_BYTES = 64 * 1024;
/** Cap on all stored patch text for one run (UTF-8 bytes). */
export const DIFF_PATCH_TOTAL_CAP_BYTES = 512 * 1024;

export interface DiffPatchFile {
  path: string;
  oldPath?: string;
  /** Redacted unified diff text for this file; "" for binary, excluded or over-total-cap files. */
  patch: string;
  truncated: boolean;
}

export interface DiffPatchResult {
  files: DiffPatchFile[];
  truncated: boolean;
}

export interface DiffPatchOptions {
  excludedPaths?: string[];
  /** Override DIFF_PATCH_FILE_CAP_BYTES (tests). */
  maxFileBytes?: number;
  /** Override DIFF_PATCH_TOTAL_CAP_BYTES (tests). */
  maxTotalBytes?: number;
}

function unquoteGitPath(p: string): string {
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    return p.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return p;
}

/** Cuts text to at most maxBytes UTF-8 bytes, preferring a line boundary. */
function cutToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let cut = buf.subarray(0, Math.max(0, maxBytes)).toString("utf8");
  // A multi-byte character cut in half decodes to U+FFFD at the end: drop it.
  if (cut.endsWith("\uFFFD")) cut = cut.slice(0, -1);
  const nl = cut.lastIndexOf("\n");
  return nl > 0 ? cut.slice(0, nl + 1) : cut;
}

/** Path(s) a `diff --git` block is about, from its rename lines or its header. */
function parsePatchBlockPaths(block: string): { path: string; oldPath?: string } | null {
  const lines = block.split("\n");
  const header = lines[0] ?? "";
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let minus: string | undefined;
  let plus: string | undefined;
  for (let i = 1; i < lines.length; i++) {
    const l = (lines[i] ?? "").replace(/\r$/, "");
    if (l.startsWith("@@")) break;
    if (l.startsWith("rename from ")) renameFrom = unquoteGitPath(l.slice(12));
    else if (l.startsWith("rename to ")) renameTo = unquoteGitPath(l.slice(10));
    // git appends a TAB after a ---/+++ path that contains a space.
    else if (l.startsWith("--- ")) minus = unquoteGitPath(l.slice(4).replace(/\t$/, ""));
    else if (l.startsWith("+++ ")) plus = unquoteGitPath(l.slice(4).replace(/\t$/, ""));
  }
  if (renameFrom !== undefined && renameTo !== undefined) {
    return { path: renameTo, oldPath: renameFrom };
  }
  if (plus && plus !== "/dev/null" && plus.startsWith("b/")) return { path: plus.slice(2) };
  if (minus && minus !== "/dev/null" && minus.startsWith("a/")) return { path: minus.slice(2) };
  // Binary or mode-only: "diff --git a/P b/P" with an identical path on both sides.
  const rest = header.replace(/\r$/, "").slice("diff --git ".length);
  const n = (rest.length - 5) / 2;
  if (Number.isInteger(n) && n > 0 && rest.startsWith("a/") && rest.slice(2, 2 + n) === rest.slice(5 + n)) {
    return { path: unquoteGitPath(rest.slice(2, 2 + n)) };
  }
  return null;
}

/**
 * Patch text per changed file between baseSha and HEAD, from ONE
 * `git diff` call. Every patch is redacted before it is returned, and capped
 * per file and in total. Binary files and excluded files carry no patch text.
 */
export async function diffPatch(
  worktreePath: string,
  baseSha: string,
  options: DiffPatchOptions = {},
): Promise<DiffPatchResult> {
  const {
    excludedPaths = [],
    maxFileBytes = DIFF_PATCH_FILE_CAP_BYTES,
    maxTotalBytes = DIFF_PATCH_TOTAL_CAP_BYTES,
  } = options;
  assertSafeBaseSha(baseSha);

  const res = await execGit(
    [
      "-c",
      "core.quotepath=off",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "-M",
      "--ignore-cr-at-eol",
      `${baseSha}...HEAD`,
    ],
    { cwd: worktreePath },
  );

  const blocks = res.stdout.split(/^(?=diff --git )/m).filter((b) => b.startsWith("diff --git "));
  const files: DiffPatchFile[] = [];
  let used = 0;
  let totalCapHit = false;

  for (const block of blocks) {
    const paths = parsePatchBlockPaths(block);
    if (!paths) continue;
    const entry = (patch: string, truncated: boolean): DiffPatchFile => ({
      path: paths.path,
      ...(paths.oldPath ? { oldPath: paths.oldPath } : {}),
      patch,
      truncated,
    });

    if (isFileExcluded(paths.path, paths.oldPath, excludedPaths)) {
      files.push(entry("", false));
      continue;
    }
    if (/^Binary files .* differ\r?$/m.test(block) || /^GIT binary patch\r?$/m.test(block)) {
      files.push(entry("", false));
      continue;
    }
    if (totalCapHit) {
      files.push(entry("", true));
      continue;
    }

    // Redact first, then cut: a secret cut in half could slip under the redaction rules.
    let patch = redactText(block);
    let truncated = false;
    if (Buffer.byteLength(patch, "utf8") > maxFileBytes) {
      patch = cutToBytes(patch, maxFileBytes);
      truncated = true;
    }
    const remaining = maxTotalBytes - used;
    if (Buffer.byteLength(patch, "utf8") > remaining) {
      patch = cutToBytes(patch, remaining);
      truncated = true;
      totalCapHit = true;
    }
    used += Buffer.byteLength(patch, "utf8");
    if (used >= maxTotalBytes) totalCapHit = true;
    files.push(entry(patch, truncated));
  }

  return { files, truncated: files.some((f) => f.truncated) };
}

/* ------------------------------------------------------------------ */
/* removeRunWorktree                                                   */
/* ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lexical normalisation for a path that no longer exists: the nearest existing
 * ancestor is realpath-normalised (so symlinked temp roots still compare
 * equal) and the missing tail is appended, case-folded where the platform
 * folds case.
 */
function normalizeLexical(p: string): string {
  let head = nodePath.resolve(p);
  const tail: string[] = [];
  while (!fs.existsSync(head)) {
    const parent = nodePath.dirname(head);
    if (parent === head) break;
    tail.unshift(nodePath.basename(head));
    head = parent;
  }
  const base = fs.existsSync(head) ? normalizeForCompare(head) : head;
  const sep = process.platform === "win32" ? "\\" : "/";
  const folds = process.platform === "win32" || process.platform === "darwin";
  let out = base;
  for (const seg of tail) {
    out = (out.endsWith(sep) ? out : out + sep) + (folds ? seg.toLowerCase() : seg);
  }
  return out;
}

function isInside(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (child === parent) return false;
  const sep = platform === "win32" ? "\\" : "/";
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

export interface RemoveRunWorktreeOptions {
  repoPath: string;
  worktreePath: string;
  worktreeRoot: string;
  backoffMs?: number[];
}

export type RemoveRunWorktreeResult =
  | { ok: true }
  | { ok: false; reason: string };

export type RemoveWorktreeOptions = RemoveRunWorktreeOptions;
export type RemoveWorktreeResult = RemoveRunWorktreeResult;

/**
 * Removes a worktree created for an agent run.
 * Refuses unless worktreePath is inside `<worktreeRoot>/command-center`.
 * Retries git worktree remove --force up to 5 times with backoff on failure.
 * Never deletes the branch.
 */
export async function removeRunWorktree(
  options: RemoveRunWorktreeOptions,
): Promise<RemoveRunWorktreeResult> {
  const { repoPath, worktreePath, worktreeRoot, backoffMs } = options;

  if (typeof repoPath !== "string" || repoPath.trim() === "") {
    return { ok: false, reason: "repoPath must be a non-empty string" };
  }
  if (typeof worktreePath !== "string" || worktreePath.trim() === "") {
    return { ok: false, reason: "worktreePath must be a non-empty string" };
  }
  if (typeof worktreeRoot !== "string" || worktreeRoot.trim() === "") {
    return { ok: false, reason: "worktreeRoot must be a non-empty string" };
  }

  const expectedParent = nodePath.join(worktreeRoot, "command-center");

  const folderExists = fs.existsSync(worktreePath);
  let normChild: string;
  let normParent: string;
  try {
    // If the folder is gone (deleted by hand), check containment lexically.
    normChild = folderExists
      ? normalizeForCompare(worktreePath)
      : normalizeLexical(worktreePath);
  } catch {
    return {
      ok: false,
      reason: `worktreePath cannot be resolved: ${worktreePath}`,
    };
  }

  try {
    normParent = fs.existsSync(expectedParent)
      ? normalizeForCompare(expectedParent)
      : normalizeLexical(expectedParent);
  } catch {
    return {
      ok: false,
      reason: `command-center root cannot be resolved: ${expectedParent}`,
    };
  }

  if (!isInside(normChild, normParent, process.platform)) {
    return {
      ok: false,
      reason: `worktreePath is not inside ${expectedParent}: ${worktreePath}`,
    };
  }

  if (!folderExists) {
    try {
      await execGit(["worktree", "prune"], { cwd: repoPath });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Linked dependency folders (AW4-14): drop the links first so nothing is ever deleted through them.
  try {
    unlinkDependencies(worktreePath);
  } catch (err) {
    return {
      ok: false,
      reason: `a shared folder link could not be removed, so the worktree was kept: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const backoff = backoffMs ?? [100, 200, 400, 800, 1600];
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    try {
      await execGit(["worktree", "remove", "--force", worktreePath], {
        cwd: repoPath,
      });
      return { ok: true };
    } catch (err) {
      lastError = err;
      if (attempt < backoff.length) {
        await sleep(backoff[attempt] ?? 0);
      }
    }
  }

  const reason =
    lastError instanceof Error ? lastError.message : String(lastError);
  return { ok: false, reason };
}

/**
 * Non-Git projects: snapshot copy + apply-back core for the Agent Workflow
 * Control Center (design note section 5 "Not a Git repository", 16.4 row 5).
 *
 * createSnapshot() copies the project into `<worktreeRoot>/command-center/snap/<shortId>/base`,
 * makes it a throwaway Git repo with one commit, and createRunWorkspace() then
 * creates the run's worktree of that repo, so diff and review work unchanged.
 *
 * planApplyBack() / applyBack() copy a run's results back into the original
 * folder: conflict check first, a timestamped backup of every file that will
 * be overwritten or deleted, then the copy, then a hash verification with
 * rollback. A later approval step calls them; nothing here runs unprompted.
 *
 * Hashes are Git blob ids (sha1 of "blob <size>\0<bytes>"), computed in-process
 * so they match `git diff --raw` output without reading binary data through git.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import {
  createRunWorktree,
  execGit,
  isGitRepo,
  matchGlob,
  shortRunId,
  type CreateRunWorktreeResult,
} from "./workspace";
import type { WorkspaceKind } from "./types";

const GIB = 1024 * 1024 * 1024;
export const DEFAULT_SNAPSHOT_MAX_FILES = 50_000;
export const DEFAULT_SNAPSHOT_MAX_BYTES = 2 * GIB;

/** Names never copied into a snapshot (matched at any depth). */
export const SNAPSHOT_SKIP_NAMES: readonly string[] = [
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "dist",
  "build",
  ".git",
  ".DS_Store",
];

const SNAPSHOT_IDENTITY = {
  name: "Command Center Snapshot",
  email: "snapshot@command-center.local",
};

/* ------------------------------------------------------------------ */
/* Path helpers                                                        */
/* ------------------------------------------------------------------ */

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function cmpKey(p: string): string {
  const resolved = nodePath.resolve(p);
  return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
}

function isInside(parent: string, child: string): boolean {
  const p = cmpKey(parent);
  const c = cmpKey(child);
  return c === p || c.startsWith(p.endsWith(nodePath.sep) ? p : p + nodePath.sep);
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return nodePath.resolve(p);
  }
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Resolve a repo-relative path inside root. Rejects empty, absolute, drive,
 * UNC and `..` paths, and any path whose existing ancestors (or the target
 * itself) are symlinks that lead outside root.
 */
export function resolveInside(root: string, rel: string): string {
  if (typeof rel !== "string" || rel === "" || rel.includes("\0")) {
    throw new Error(`Invalid path: ${JSON.stringify(rel)}`);
  }
  if (rel.startsWith("/") || rel.startsWith("\\") || /^[A-Za-z]:/.test(rel) || nodePath.isAbsolute(rel)) {
    throw new Error(`Absolute paths are not allowed: ${JSON.stringify(rel)}`);
  }
  const segments = rel.split(/[\\/]+/);
  if (segments.some((s) => s === "..")) {
    throw new Error(`Path escapes the project folder: ${JSON.stringify(rel)}`);
  }
  const abs = nodePath.resolve(root, ...segments);
  if (!isInside(root, abs) || cmpKey(abs) === cmpKey(root)) {
    throw new Error(`Path escapes the project folder: ${JSON.stringify(rel)}`);
  }
  // Walk up to the deepest existing ancestor and make sure it is really inside root.
  const realRoot = realOrSelf(root);
  let probe = abs;
  while (!fs.existsSync(probe) && !isLink(probe)) {
    const up = nodePath.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  if (!isInside(realRoot, realOrSelf(probe))) {
    throw new Error(`Path escapes the project folder through a link: ${JSON.stringify(rel)}`);
  }
  if (isLink(abs)) {
    throw new Error(`Refusing to touch a symbolic link: ${JSON.stringify(rel)}`);
  }
  return abs;
}

/** Git blob id of a file's bytes, or null when the file does not exist. */
export function hashFile(file: string): string | null {
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return crypto.createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}

/* ------------------------------------------------------------------ */
/* createSnapshot                                                      */
/* ------------------------------------------------------------------ */

export interface CreateSnapshotOptions {
  sourceDir: string;
  worktreeRoot: string;
  runId: string;
  excludedPaths: string[];
  maxFiles?: number;
  maxBytes?: number;
}

export interface CreateSnapshotResult {
  baseRepo: string;
  baseSha: string;
  fileCount: number;
  totalBytes: number;
  skipped: string[];
}

export function snapshotBasePathFor(worktreeRoot: string, runId: string): string {
  return nodePath.join(worktreeRoot, "command-center", "snap", shortRunId(runId), "base");
}

/**
 * Copies sourceDir into a fresh one-commit Git repo. Symlinks and junctions are
 * never followed (skipped and listed), policy-excluded paths and heavy folders
 * are not copied. A partial copy is removed when a limit is exceeded or
 * anything fails.
 */
export async function createSnapshot(options: CreateSnapshotOptions): Promise<CreateSnapshotResult> {
  const {
    sourceDir,
    worktreeRoot,
    runId,
    excludedPaths,
    maxFiles = DEFAULT_SNAPSHOT_MAX_FILES,
    maxBytes = DEFAULT_SNAPSHOT_MAX_BYTES,
  } = options;
  if (typeof sourceDir !== "string" || sourceDir.trim() === "") {
    throw new Error("sourceDir must be a non-empty string");
  }
  if (typeof worktreeRoot !== "string" || worktreeRoot.trim() === "") {
    throw new Error("worktreeRoot must be a non-empty string");
  }
  const srcStat = fs.statSync(sourceDir, { throwIfNoEntry: false });
  if (!srcStat || !srcStat.isDirectory()) {
    throw new Error(`sourceDir is not a directory: ${sourceDir}`);
  }
  const realSource = realOrSelf(sourceDir);
  const realWorktreeRoot = realOrSelf(worktreeRoot);
  if (isInside(realWorktreeRoot, realSource)) {
    throw new Error("sourceDir must not be inside the worktree root");
  }
  if (await isGitRepo(sourceDir)) {
    throw new Error("sourceDir is a Git repository; use a Git worktree instead of a snapshot");
  }

  const baseRepo = snapshotBasePathFor(worktreeRoot, runId);
  const snapDir = nodePath.dirname(baseRepo);
  if (fs.existsSync(snapDir)) {
    throw new Error(`A snapshot already exists for this run: ${snapDir}`);
  }

  const skipped: string[] = [];
  let fileCount = 0;
  let totalBytes = 0;

  const walk = (relDir: string): void => {
    const absDir = relDir === "" ? sourceDir : nodePath.join(sourceDir, ...relDir.split("/"));
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      const abs = nodePath.join(absDir, entry.name);
      const lst = fs.lstatSync(abs);
      if (lst.isSymbolicLink()) {
        skipped.push(rel);
        continue;
      }
      const label = lst.isDirectory() ? `${rel}/` : rel;
      if (SNAPSHOT_SKIP_NAMES.includes(entry.name) || excludedPaths.some((g) => matchGlob(g, rel))) {
        skipped.push(label);
        continue;
      }
      if (lst.isDirectory()) {
        // Junctions can look like plain directories: re-check where they really lead.
        const real = realOrSelf(abs);
        if (!isInside(realSource, real) || isInside(realWorktreeRoot, real)) {
          skipped.push(label);
          continue;
        }
        fs.mkdirSync(nodePath.join(baseRepo, ...rel.split("/")), { recursive: true });
        walk(rel);
        continue;
      }
      if (!lst.isFile()) {
        skipped.push(rel);
        continue;
      }
      if (fileCount + 1 > maxFiles) {
        throw new Error(`Snapshot refused: more than ${maxFiles} files`);
      }
      if (totalBytes + lst.size > maxBytes) {
        throw new Error(`Snapshot refused: more than ${maxBytes} bytes`);
      }
      fs.copyFileSync(abs, nodePath.join(baseRepo, ...rel.split("/")));
      fileCount += 1;
      totalBytes += lst.size;
    }
  };

  try {
    fs.mkdirSync(baseRepo, { recursive: true });
    walk("");
    await execGit(["init", "-b", "main"], { cwd: baseRepo });
    await execGit(["config", "core.autocrlf", "false"], { cwd: baseRepo });
    await execGit(["config", "core.safecrlf", "false"], { cwd: baseRepo });
    // -f: a project's own .gitignore must not drop files from the snapshot.
    await execGit(["add", "-A", "-f"], { cwd: baseRepo });
    await execGit(
      [
        "-c",
        `user.name=${SNAPSHOT_IDENTITY.name}`,
        "-c",
        `user.email=${SNAPSHOT_IDENTITY.email}`,
        "commit",
        "--no-verify",
        "--allow-empty",
        "-m",
        "snapshot: base",
      ],
      { cwd: baseRepo },
    );
    const rev = await execGit(["rev-parse", "HEAD"], { cwd: baseRepo });
    return { baseRepo, baseSha: rev.stdout.trim(), fileCount, totalBytes, skipped };
  } catch (err) {
    fs.rmSync(snapDir, { recursive: true, force: true });
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Workspace selection                                                 */
/* ------------------------------------------------------------------ */

export interface CreateRunWorkspaceOptions {
  repoPath: string;
  worktreeRoot: string;
  runId: string;
  excludedPaths?: string[];
}

export interface CreateRunWorkspaceResult extends CreateRunWorktreeResult {
  kind: WorkspaceKind;
  /** Snapshot runs only: the throwaway repo the worktree belongs to (needed to remove it later). */
  baseRepo?: string;
}

/**
 * Git projects get a normal worktree; anything else gets a snapshot copy whose
 * throwaway repo then gets the run's worktree.
 */
export async function createRunWorkspace(options: CreateRunWorkspaceOptions): Promise<CreateRunWorkspaceResult> {
  const { repoPath, worktreeRoot, runId, excludedPaths = [] } = options;
  if (await isGitRepo(repoPath)) {
    const ws = await createRunWorktree({ repoPath, worktreeRoot, runId });
    return { ...ws, kind: "git_worktree" };
  }
  const snap = await createSnapshot({ sourceDir: repoPath, worktreeRoot, runId, excludedPaths });
  const ws = await createRunWorktree({ repoPath: snap.baseRepo, worktreeRoot, runId, baseRef: snap.baseSha });
  return { ...ws, kind: "snapshot_copy", baseRepo: snap.baseRepo };
}

/* ------------------------------------------------------------------ */
/* planApplyBack                                                       */
/* ------------------------------------------------------------------ */

export interface ApplyBackEntry {
  path: string;
  action: "write" | "delete";
  /** Hash the original file must still have (what the snapshot saw); null = must not exist. */
  sourceHashBefore: string | null;
  /** Hash the file must have after a write; null for deletes. */
  newHash: string | null;
}

export interface PlanApplyBackOptions {
  runWorktree: string;
  baseSha: string;
  sourceDir: string;
  /** Policy globs; a changed path matching one makes the plan refuse. */
  excludedPaths?: string[];
}

const ZERO_SHA = "0".repeat(40);

function assertNotExcluded(rel: string, excludedPaths: string[] | undefined): void {
  if (excludedPaths?.some((g) => matchGlob(g, rel))) {
    throw new Error(`Refusing to apply an excluded path: ${rel}`);
  }
}

/**
 * Lists what applying the run's committed result would do to sourceDir.
 * Renames come out as a delete plus a write.
 */
export async function planApplyBack(options: PlanApplyBackOptions): Promise<ApplyBackEntry[]> {
  const { runWorktree, baseSha, sourceDir, excludedPaths } = options;
  if (typeof baseSha !== "string" || !/^[0-9a-f]{7,64}$/.test(baseSha)) {
    throw new Error(`Invalid baseSha: ${JSON.stringify(baseSha)}`);
  }
  const res = await execGit(["diff", "--raw", "-z", "--no-renames", "--no-abbrev", baseSha, "HEAD"], {
    cwd: runWorktree,
  });
  // Records: ":<modeA> <modeB> <shaA> <shaB> <status>" NUL path NUL
  const parts = res.stdout.split("\0");
  const plan: ApplyBackEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i] ?? "";
    const rel = parts[i + 1] ?? "";
    const m = /^:(\d+) (\d+) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])\d*$/.exec(meta);
    if (!m) throw new Error(`Unexpected git diff output: ${JSON.stringify(meta)}`);
    const oldMode = m[1];
    const newMode = m[2];
    const oldSha = m[3];
    const newSha = m[4];
    const status = m[5];
    if (oldMode === "120000" || newMode === "120000" || oldMode === "160000" || newMode === "160000") {
      throw new Error(`Symbolic links and submodules cannot be applied back: ${rel}`);
    }
    assertNotExcluded(rel, excludedPaths);
    resolveInside(sourceDir, rel);
    const before = oldSha === ZERO_SHA || oldSha === undefined ? null : oldSha;
    if (status === "D") {
      plan.push({ path: rel, action: "delete", sourceHashBefore: before, newHash: null });
    } else if (status === "A" || status === "M" || status === "T") {
      plan.push({ path: rel, action: "write", sourceHashBefore: before, newHash: newSha ?? null });
    } else {
      throw new Error(`Unsupported change status ${String(status)} for ${rel}`);
    }
  }
  return plan;
}

/* ------------------------------------------------------------------ */
/* applyBack                                                           */
/* ------------------------------------------------------------------ */

export interface ApplyBackOptions {
  sourceDir: string;
  runWorktree: string;
  backupRoot: string;
  now: Date;
  /** Folder-name suffix for the backup; defaults to the run worktree's folder name. */
  shortId?: string;
  /** Policy globs; re-checked here so a hand-built plan cannot touch excluded paths. */
  excludedPaths?: string[];
}

export interface ApplyBackDeps {
  /** Replaceable for tests; defaults to fs.copyFileSync. */
  copyFile?: (src: string, dest: string) => void;
}

export interface ApplyBackResult {
  written: string[];
  deleted: string[];
  backupDir: string;
}

function stamp(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

function relParts(rel: string): string[] {
  return rel.split(/[\\/]+/);
}

export function applyBack(
  plan: ApplyBackEntry[],
  options: ApplyBackOptions,
  deps: ApplyBackDeps = {},
): ApplyBackResult {
  const { sourceDir, runWorktree, backupRoot, now, excludedPaths } = options;
  const copy = deps.copyFile ?? ((s: string, d: string) => fs.copyFileSync(s, d));
  const shortId = (options.shortId ?? nodePath.basename(runWorktree)).replace(/[^A-Za-z0-9_-]/g, "") || "run";

  // 1. Validate every path and check for conflicts before touching anything.
  const targets = plan.map((entry) => {
    assertNotExcluded(entry.path, excludedPaths);
    const target = resolveInside(sourceDir, entry.path);
    const current = hashFile(target);
    if (current !== entry.sourceHashBefore) {
      throw new Error(`Conflict: ${entry.path} changed in the original folder since the snapshot; nothing was applied`);
    }
    let from: string | null = null;
    if (entry.action === "write") {
      from = resolveInside(runWorktree, entry.path);
      if (entry.newHash === null || hashFile(from) !== entry.newHash) {
        throw new Error(`Run result for ${entry.path} does not match the planned hash; nothing was applied`);
      }
    }
    return { entry, target, from, existed: current !== null };
  });

  // 2. Backup of everything that will be overwritten or deleted, plus a manifest.
  const backupDir = nodePath.join(backupRoot, `${stamp(now)}-${shortId}`);
  if (fs.existsSync(backupDir)) {
    throw new Error(`Backup folder already exists: ${backupDir}`);
  }
  fs.mkdirSync(backupDir, { recursive: true });
  for (const t of targets) {
    if (!t.existed) continue;
    const dest = nodePath.join(backupDir, ...relParts(t.entry.path));
    fs.mkdirSync(nodePath.dirname(dest), { recursive: true });
    fs.copyFileSync(t.target, dest);
  }
  fs.writeFileSync(
    nodePath.join(backupDir, "manifest.json"),
    JSON.stringify(
      {
        createdAt: now.toISOString(),
        sourceDir,
        entries: plan.map((e) => ({
          path: e.path,
          action: e.action,
          sourceHashBefore: e.sourceHashBefore,
          newHash: e.newHash,
        })),
      },
      null,
      2,
    ),
  );

  // 3. Apply, then 4. verify; any failure restores from the backup.
  const createdDirs: string[] = [];
  const touched: typeof targets = [];
  const rollback = (): void => {
    for (const t of touched) {
      try {
        if (t.existed) {
          const saved = nodePath.join(backupDir, ...relParts(t.entry.path));
          fs.mkdirSync(nodePath.dirname(t.target), { recursive: true });
          fs.copyFileSync(saved, t.target);
        } else {
          fs.rmSync(t.target, { force: true });
        }
      } catch {
        // keep restoring the rest; the backup folder still holds every original
      }
    }
    for (const dir of [...createdDirs].reverse()) {
      try {
        fs.rmdirSync(dir);
      } catch {
        // not empty or already gone
      }
    }
  };

  const written: string[] = [];
  const deleted: string[] = [];
  try {
    for (const t of targets) {
      if (t.entry.action === "delete") {
        if (!t.existed) continue;
        touched.push(t);
        fs.rmSync(t.target, { force: true });
        deleted.push(t.entry.path);
        continue;
      }
      const parent = nodePath.dirname(t.target);
      const missing: string[] = [];
      for (let dir = parent; !fs.existsSync(dir); dir = nodePath.dirname(dir)) missing.push(dir);
      fs.mkdirSync(parent, { recursive: true });
      createdDirs.push(...missing.reverse());
      touched.push(t);
      copy(t.from as string, t.target);
      written.push(t.entry.path);
    }
    for (const t of targets) {
      if (t.entry.action === "write") {
        if (hashFile(t.target) !== t.entry.newHash) {
          throw new Error(`Verification failed for ${t.entry.path}; the original folder was restored from the backup`);
        }
      } else if (fs.existsSync(t.target)) {
        throw new Error(`Verification failed: ${t.entry.path} still exists; the original folder was restored from the backup`);
      }
    }
  } catch (err) {
    rollback();
    throw err;
  }
  return { written, deleted, backupDir };
}

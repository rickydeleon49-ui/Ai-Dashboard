/**
 * Workspace roots, path containment, drive check and workspace locks for the
 * Agent Workflow Control Center (AW sections 5, 5A and 6).
 *
 * The pure helpers (normalizeForCompare, resolveProjectPath, checkRootAvailable,
 * validators) touch no database. Settings access goes through an injectable
 * store; the default store is loaded lazily so importing this module never
 * opens the application database.
 */
import fs from "node:fs";
import nodePath from "node:path";
import { and, eq } from "drizzle-orm";
import { agentWorkspaceLocks } from "@/db/schema";
import { resolveDatabasePath } from "@/db/path";
import type { AgentDatabase } from "./events";
import { isSafeAbsolute } from "./resolve-executable";

export type RealpathFn = (p: string) => string;

export interface PathDeps {
  platform?: NodeJS.Platform;
  realpath?: RealpathFn;
}

const defaultRealpath: RealpathFn = (p) => fs.realpathSync.native(p);

function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? nodePath.win32 : nodePath.posix;
}

function sepFor(platform: NodeJS.Platform): string {
  return platform === "win32" ? "\\" : "/";
}

/** Windows and macOS file systems are case-insensitive by default. */
function foldsCase(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/** Normalise an already-resolved path string (no filesystem access). */
function normalizeString(p: string, platform: NodeJS.Platform): string {
  const pp = pathFor(platform);
  let out = p;
  if (platform === "win32") out = out.replace(/\//g, "\\");
  out = pp.normalize(out);
  const root = pp.parse(out).root;
  while (out.length > root.length && out.endsWith(sepFor(platform)))
    out = out.slice(0, -1);
  if (platform === "win32") {
    // Win32 drops trailing dots and spaces from each path segment, so
    // "run-1." and "run-1 " are the same directory as "run-1".
    const rest = out.slice(root.length);
    const segs = rest
      .split("\\")
      .map((x) => x.replace(/[. ]+$/, ""))
      .filter((x) => x !== "");
    out = root + segs.join("\\");
  }
  return foldsCase(platform) ? out.toLowerCase() : out;
}

/**
 * Realpath, then case-fold (Windows/macOS), normalise separators and drop the
 * trailing separator. Throws if the path does not exist.
 */
export function normalizeForCompare(
  p: string,
  platform: NodeJS.Platform = process.platform,
  realpath: RealpathFn = defaultRealpath,
): string {
  return normalizeString(realpath(p), platform);
}

/** Boundary-aware: "/a/bX" is not inside "/a/b". */
function isInside(
  child: string,
  parent: string,
  platform: NodeJS.Platform,
): boolean {
  if (child === parent) return true;
  const sep = sepFor(platform);
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

export type ResolveProjectPathResult =
  { ok: true; realPath: string; root: string } | { ok: false; reason: string };

export function resolveProjectPath(
  input: string,
  roots: readonly string[],
  deps: PathDeps = {},
): ResolveProjectPathResult {
  const platform = deps.platform ?? process.platform;
  const realpath = deps.realpath ?? defaultRealpath;

  if (typeof input !== "string" || input.trim() === "") {
    return { ok: false, reason: "path is empty" };
  }
  if (!isSafeAbsolute(input, platform)) {
    return {
      ok: false,
      reason:
        "path must be absolute (relative, UNC and device paths are refused)",
    };
  }
  let real: string;
  try {
    real = realpath(input);
  } catch {
    return { ok: false, reason: "path does not exist" };
  }
  // A realpath can itself be a UNC/device path (e.g. a mapped network drive).
  if (!isSafeAbsolute(real, platform)) {
    return { ok: false, reason: "path resolves outside a local drive" };
  }
  const realNorm = normalizeString(real, platform);

  for (const root of roots) {
    let rootReal: string;
    try {
      rootReal = realpath(root);
    } catch {
      continue; // an unavailable root can never contain anything
    }
    // A root that resolves to an unsafe path or a filesystem root (e.g. a
    // junction pointing at a drive root) would grant a whole drive.
    if (
      !isSafeAbsolute(rootReal, platform) ||
      isFilesystemRoot(rootReal, platform)
    ) {
      continue;
    }
    if (isInside(realNorm, normalizeString(rootReal, platform), platform)) {
      return { ok: true, realPath: real, root };
    }
  }
  return { ok: false, reason: "path is not inside a workspace root" };
}

export type RootAvailability =
  { ok: true } | { ok: false; reason: "root unavailable" };

/** The root (and so its drive) must exist as a directory. Never falls back to another drive. */
export function checkRootAvailable(
  root: string,
  deps: { isDirectory?: (p: string) => boolean } = {},
): RootAvailability {
  const isDirectory =
    deps.isDirectory ??
    ((p: string) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  return isDirectory(root)
    ? { ok: true }
    : { ok: false, reason: "root unavailable" };
}

export interface RootStatus {
  path: string;
  available: boolean;
  drive: string;
  fileSystem?: string;
  warning?: string;
  note?: string;
}

export interface InspectRootDeps {
  platform?: NodeJS.Platform;
  checkAvailable?: typeof checkRootAvailable;
  getFsType?: (p: string) => string | undefined;
  createdOnDemand?: boolean;
  driveExists?: (p: string) => boolean;
}

/**
 * Inspect drive and filesystem status for a workspace or worktree root (design §5 and §9).
 * Checks whether the drive/directory is available, identifies the drive root,
 * and warns if filesystem is not NTFS on Windows (or APFS on macOS).
 */
export function inspectRootStatus(
  rootPath: string,
  deps: InspectRootDeps = {},
): RootStatus {
  const platform = deps.platform ?? process.platform;
  const check = deps.checkAvailable ?? checkRootAvailable;
  const pp = pathFor(platform);
  const rootDir = pp.parse(rootPath).root || rootPath;
  const avail = check(rootPath);

  if (!avail.ok) {
    const driveCheck =
      deps.driveExists ??
      ((p: string) => {
        try {
          return fs.existsSync(p);
        } catch {
          return false;
        }
      });

    if (deps.createdOnDemand && driveCheck(rootDir)) {
      return {
        path: rootPath,
        available: true,
        drive: rootDir,
        note: "Created on the first run.",
      };
    }

    return {
      path: rootPath,
      available: false,
      drive: rootDir,
      warning: "Root directory or drive is unavailable. Agent runs will refuse to start.",
    };
  }

  // Only report a filesystem type a real probe supplied; never guess one.
  const fsType = deps.getFsType?.(rootPath);

  const warning = !fsType
    ? undefined
    : platform === "win32" && fsType !== "NTFS"
      ? `Warning: Filesystem is ${fsType}, but NTFS is recommended for permissions and worktrees`
      : platform === "darwin" && fsType !== "APFS"
        ? `Warning: Filesystem is ${fsType}, but APFS is recommended`
        : undefined;

  return {
    path: rootPath,
    available: true,
    drive: rootDir,
    fileSystem: fsType,
    warning,
  };
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export interface SettingsStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

async function defaultStore(): Promise<SettingsStore> {
  const svc = await import("@/core/settings/service");
  return {
    get: (k) => svc.getSetting(k as never),
    set: (k, v) => svc.setSetting(k as never, v),
  };
}

const KEY_ROOTS = "agent.workspace_roots";
const KEY_WORKTREE = "agent.worktree_root";
const KEY_RUN_STORE = "agent.run_store";

export interface AgentStorageSettings {
  workspaceRoots: string[];
  worktreeRoot: string;
  runStore: string;
}

export interface StorageOptions {
  store?: SettingsStore;
  /**
   * The desktop shell's userData directory. The shell does not export it as an
   * env var, but it sets DATABASE_PATH to `<userData>/data/dashboard.db`, so
   * the default is derived from that rather than inventing a new mechanism.
   */
  userData?: string;
  platform?: NodeJS.Platform;
  realpath?: RealpathFn;
}

export function defaultUserData(): string {
  return nodePath.dirname(nodePath.dirname(resolveDatabasePath()));
}

export async function getAgentStorageSettings(
  opts: StorageOptions = {},
): Promise<AgentStorageSettings> {
  const store = opts.store ?? (await defaultStore());
  const userData = opts.userData ?? defaultUserData();
  const runStore =
    store.get(KEY_RUN_STORE) ?? nodePath.join(userData, "agent-runs");
  const worktreeRoot =
    store.get(KEY_WORKTREE) ?? nodePath.join(userData, "agent-worktrees");
  let workspaceRoots: string[] = [];
  const raw = store.get(KEY_ROOTS);
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        workspaceRoots = parsed.filter(
          (x): x is string => typeof x === "string",
        );
      }
    } catch {
      workspaceRoots = [];
    }
  }
  return { workspaceRoots, worktreeRoot, runStore };
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

function lexical(p: string, platform: NodeJS.Platform): string {
  return normalizeString(pathFor(platform).resolve(p), platform);
}

function isFilesystemRoot(p: string, platform: NodeJS.Platform): boolean {
  const pp = pathFor(platform);
  const resolved = pp.resolve(p);
  return pp.parse(resolved).root === resolved;
}

export interface ValidateContext {
  /** Other storage locations the candidate must not contain or sit inside. */
  others?: string[];
  realpath?: RealpathFn;
}

function tryReal(p: string, realpath: RealpathFn): string | null {
  try {
    return realpath(p);
  } catch {
    return null;
  }
}

/**
 * Absolute, safe, not a filesystem root, and not nested (either way) with the
 * run store or any other listed location. Checked lexically and, when the
 * candidate exists, on its realpath too (a junction to a drive root fails).
 */
export function validateStorageRoot(
  candidate: string,
  runStore: string,
  platform: NodeJS.Platform = process.platform,
  ctx: ValidateContext = {},
): ValidationResult {
  const realpath = ctx.realpath ?? defaultRealpath;
  if (typeof candidate !== "string" || !isSafeAbsolute(candidate, platform)) {
    return {
      ok: false,
      reason: `not an absolute local path: ${String(candidate)}`,
    };
  }
  if (isFilesystemRoot(candidate, platform)) {
    return {
      ok: false,
      reason: `a filesystem root is not allowed: ${candidate}`,
    };
  }
  const real = tryReal(candidate, realpath);
  if (real !== null) {
    if (!isSafeAbsolute(real, platform)) {
      return {
        ok: false,
        reason: `resolves outside a local drive: ${candidate}`,
      };
    }
    if (isFilesystemRoot(real, platform)) {
      return {
        ok: false,
        reason: `resolves to a filesystem root: ${candidate}`,
      };
    }
  }
  const forms = (p: string): string[] => {
    const out = [lexical(p, platform)];
    const r = tryReal(p, realpath);
    if (r !== null) out.push(normalizeString(r, platform));
    return out;
  };
  const mine = forms(candidate);
  for (const other of [runStore, ...(ctx.others ?? [])]) {
    for (const o of forms(other)) {
      for (const c of mine) {
        if (isInside(c, o, platform)) {
          return { ok: false, reason: `inside ${other}: ${candidate}` };
        }
        if (isInside(o, c, platform)) {
          return { ok: false, reason: `contains ${other}: ${candidate}` };
        }
      }
    }
  }
  return { ok: true };
}

export async function setWorkspaceRoots(
  roots: string[],
  opts: StorageOptions = {},
): Promise<ValidationResult> {
  const platform = opts.platform ?? process.platform;
  const store = opts.store ?? (await defaultStore());
  const { runStore, worktreeRoot } = await getAgentStorageSettings({
    ...opts,
    store,
  });
  const clean = [
    ...new Set(roots.map((r) => (typeof r === "string" ? r.trim() : r))),
  ];
  for (const r of clean) {
    const v = validateStorageRoot(r, runStore, platform, {
      others: [worktreeRoot],
      realpath: opts.realpath,
    });
    if (!v.ok) return v;
  }
  store.set(KEY_ROOTS, JSON.stringify(clean));
  return { ok: true };
}

export async function setWorktreeRoot(
  root: string,
  opts: StorageOptions = {},
): Promise<ValidationResult> {
  const platform = opts.platform ?? process.platform;
  const store = opts.store ?? (await defaultStore());
  const { runStore, workspaceRoots } = await getAgentStorageSettings({
    ...opts,
    store,
  });
  const trimmed = typeof root === "string" ? root.trim() : root;
  const v = validateStorageRoot(trimmed, runStore, platform, {
    others: workspaceRoots,
    realpath: opts.realpath,
  });
  if (!v.ok) return v;
  store.set(KEY_WORKTREE, trimmed);
  return { ok: true };
}

export async function setRunStore(
  storePath: string,
  opts: StorageOptions = {},
): Promise<ValidationResult> {
  const platform = opts.platform ?? process.platform;
  const store = opts.store ?? (await defaultStore());
  const { workspaceRoots, worktreeRoot } = await getAgentStorageSettings({
    ...opts,
    store,
  });
  const trimmed = typeof storePath === "string" ? storePath.trim() : storePath;
  // The candidate is passed as its own "run store" slot; the real others follow.
  const v = validateStorageRoot(trimmed, worktreeRoot, platform, {
    others: workspaceRoots,
    realpath: opts.realpath,
  });
  if (!v.ok) return v;
  store.set(KEY_RUN_STORE, trimmed);
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Locks                                                               */
/* ------------------------------------------------------------------ */

export type AcquireLockResult =
  | { ok: true; lockKey: string }
  | { ok: false; heldBy: string; lockKey: string };

/**
 * Realpath of the nearest existing ancestor plus the remaining components, so
 * the key is identical before and after the working copy is created, even
 * through a junction, symlink, subst drive or 8.3 name in the parents.
 */
function lockKeyFor(workingCopyPath: string, deps: PathDeps): string {
  const platform = deps.platform ?? process.platform;
  const realpath = deps.realpath ?? defaultRealpath;
  const pp = pathFor(platform);
  let current = pp.resolve(workingCopyPath);
  const rest: string[] = [];
  for (;;) {
    try {
      return normalizeString(pp.join(realpath(current), ...rest), platform);
    } catch {
      const parent = pp.dirname(current);
      if (parent === current) break;
      rest.unshift(pp.basename(current));
      current = parent;
    }
  }
  return lexical(workingCopyPath, platform);
}

/** Runs inside the caller's transaction when `db` is one. */
export function acquireWorkspaceLock(
  db: AgentDatabase,
  runId: string,
  workingCopyPath: string,
  deps: PathDeps = {},
): AcquireLockResult {
  const lockKey = lockKeyFor(workingCopyPath, deps);
  const inserted = db
    .insert(agentWorkspaceLocks)
    .values({ lockKey, runId })
    .onConflictDoNothing()
    .returning({ lockKey: agentWorkspaceLocks.lockKey })
    .all();
  if (inserted.length > 0) return { ok: true, lockKey };
  const held = db
    .select({ runId: agentWorkspaceLocks.runId })
    .from(agentWorkspaceLocks)
    .where(eq(agentWorkspaceLocks.lockKey, lockKey))
    .get();
  // Re-acquiring by the owner is idempotent.
  if (held && held.runId === runId) return { ok: true, lockKey };
  return { ok: false, heldBy: held?.runId ?? "unknown", lockKey };
}

/**
 * Deletes the lock only if `runId` holds it. Takes the key returned by
 * acquireWorkspaceLock: re-deriving it from the path would differ once the
 * working copy exists (junction, 8.3 name), leaking the lock.
 */
export function releaseWorkspaceLock(
  db: AgentDatabase,
  runId: string,
  lockKey: string,
): void {
  db.delete(agentWorkspaceLocks)
    .where(
      and(
        eq(agentWorkspaceLocks.lockKey, lockKey),
        eq(agentWorkspaceLocks.runId, runId),
      ),
    )
    .run();
}

export function releaseLocksForRun(db: AgentDatabase, runId: string): void {
  db.delete(agentWorkspaceLocks)
    .where(eq(agentWorkspaceLocks.runId, runId))
    .run();
}

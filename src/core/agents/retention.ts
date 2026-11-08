/**
 * Worktree retention (Release AW.4, AW4-11, design §5 cleanup rule).
 *
 * "Cleanup removes worktrees only for runs you have dismissed, and never removes a
 * branch that has unmerged commits without asking." This module plans and applies
 * that, and nothing else:
 *
 *  - only runs recorded in OUR database, dismissed at least N days ago, whose
 *    recorded worktree is a direct child of `<worktreeRoot>/command-center/`;
 *  - a worktree with uncommitted or untracked files, a branch with commits that no
 *    other local or remote-tracking branch has, an open approval, a held lock: all
 *    SKIPPED, never forced, and left exactly as they are;
 *  - the branch is deleted only with `git branch -d` (never -D);
 *  - a snapshot run also loses its throwaway base repo, never your original folder
 *    and never the apply-back backups in the run store.
 *
 * planRetention only reads (it takes and gives back a lock to probe it);
 * applyRetention re-checks every candidate right before acting on it.
 */
import fs from "node:fs";
import nodePath from "node:path";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { agentRunApprovals, agentRunIntents, agentRuns, agentWorkspaceLocks } from "@/db/schema";
import { approvalEnvFor, OPEN_STATUSES } from "./approvals";
import { appendEvent, type AgentDatabase } from "./events";
import {
  acquireWorkspaceLock,
  getAgentStorageSettings,
  getRetentionDays,
  normalizeForCompare,
  releaseWorkspaceLock,
  type AgentStorageSettings,
  type PathDeps,
} from "./roots";
import { getRun, type AgentRunRecord } from "./runs";
import { TERMINAL_STATUSES } from "./types";
import { execGit, removeRunWorktree, shortRunId } from "./workspace";

export const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const BRANCH_PATTERN = /^agent\/[0-9a-f]{12}$/;
const BLOCKING_INTENT_KINDS = ["resume", "approval_execute"];

export interface RetentionCandidate {
  runId: string;
  worktreePath: string;
  branch: string | null;
  action: "remove_worktree" | "skip";
  reason: string;
  /** "git_worktree" or "snapshot_copy". */
  workspaceKind: string | null;
  dismissedAt: string;
}

export interface RetentionDeps {
  /** The worktree root and the retention setting. Defaults to the saved settings. */
  getStorage?: () => Promise<{ worktreeRoot: string; retentionDays: number | null; storage?: AgentStorageSettings }>;
  /** The project's real folder for a run, or null when it cannot be resolved. Defaults to the project's local path checked against the workspace roots. */
  repoPathFor?: (run: AgentRunRecord) => Promise<string | null>;
  pathDeps?: PathDeps;
}

export interface RetentionOutcome {
  runId: string;
  reason: string;
}

export interface ApplyRetentionResult {
  removed: Array<RetentionOutcome & { branchDeleted: boolean; snapshotFolderRemoved: boolean }>;
  skipped: RetentionOutcome[];
}

type Storage = { worktreeRoot: string; retentionDays: number | null; storage?: AgentStorageSettings };

async function defaultStorage(): Promise<Storage> {
  const storage = await getAgentStorageSettings();
  return { worktreeRoot: storage.worktreeRoot, retentionDays: await getRetentionDays(), storage };
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

function foldsCase(): boolean {
  return process.platform === "win32" || process.platform === "darwin";
}

/** Realpath of the nearest existing ancestor plus the missing tail, case-folded where the platform folds case. */
function normalizeAny(p: string): string {
  let head = nodePath.resolve(p);
  const tail: string[] = [];
  while (!fs.existsSync(head)) {
    const parent = nodePath.dirname(head);
    if (parent === head) break;
    tail.unshift(nodePath.basename(head));
    head = parent;
  }
  let base: string;
  try {
    base = normalizeForCompare(head);
  } catch {
    base = foldsCase() ? head.toLowerCase() : head;
  }
  let out = base;
  for (const seg of tail) {
    out = nodePath.join(out, foldsCase() ? seg.toLowerCase() : seg);
  }
  return out;
}

/** The recorded worktree must be a DIRECT child of `<worktreeRoot>/command-center` (so never the `snap` folder or anything outside). */
export function isRunWorktreePath(worktreeRoot: string, worktreePath: string): boolean {
  if (!worktreeRoot.trim() || !worktreePath.trim()) return false;
  if (!nodePath.isAbsolute(worktreePath)) return false;
  const center = normalizeAny(nodePath.join(worktreeRoot, "command-center"));
  const child = normalizeAny(worktreePath);
  if (nodePath.basename(child) === "snap") return false;
  return nodePath.dirname(child) === center;
}

function snapshotFolderFor(worktreeRoot: string, runId: string): string {
  return nodePath.join(worktreeRoot, "command-center", "snap", shortRunId(runId));
}

/* ------------------------------------------------------------------ */
/* Git                                                                 */
/* ------------------------------------------------------------------ */

async function gitOut(cwd: string, args: string[]): Promise<string> {
  return (await execGit(args, { cwd })).stdout;
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await gitOut(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Commits on the run branch that no other local branch or remote-tracking branch has. */
async function unmergedCount(repo: string, branch: string): Promise<number> {
  const out = await gitOut(repo, [
    "rev-list",
    "--count",
    `refs/heads/${branch}`,
    "--not",
    `--exclude=${branch}`,
    "--branches",
    "--remotes",
  ]);
  const n = Number.parseInt(out.trim(), 10);
  // Unreadable output counts as unmerged, so nothing is removed on a doubt.
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/* ------------------------------------------------------------------ */
/* Assessment                                                          */
/* ------------------------------------------------------------------ */

interface Assessment {
  action: "remove_worktree" | "skip";
  reason: string;
  /** The repo that owns the worktree and branch (the project, or the snapshot's base repo). */
  gitRepo?: string;
  /** The folder whose workspace lock guards the run (the project folder when known). */
  lockPath?: string;
}

const skip = (reason: string): Assessment => ({ action: "skip", reason });

async function defaultRepoPathFor(db: AgentDatabase, run: AgentRunRecord, storage: Storage, pathDeps?: PathDeps): Promise<string | null> {
  try {
    const settings = storage.storage ?? (await getAgentStorageSettings());
    const env = await approvalEnvFor(db, run, async () => settings, pathDeps);
    return env.repoPath;
  } catch {
    return null;
  }
}

async function assess(db: AgentDatabase, run: AgentRunRecord, storage: Storage, deps: RetentionDeps): Promise<Assessment> {
  const worktree = run.workspacePath;
  if (!worktree || !isRunWorktreePath(storage.worktreeRoot, worktree)) {
    return skip("The recorded worktree is not inside the Command Center worktree folder; nothing is touched");
  }
  if (!(TERMINAL_STATUSES as readonly string[]).includes(run.status)) {
    return skip(`The run is ${run.status}, not finished`);
  }
  if (!run.branch || !BRANCH_PATTERN.test(run.branch)) {
    return skip("The run has no valid run branch recorded");
  }
  const openApproval = db
    .select({ kind: agentRunApprovals.kind })
    .from(agentRunApprovals)
    .where(and(eq(agentRunApprovals.runId, run.id), inArray(agentRunApprovals.status, OPEN_STATUSES)))
    .get();
  if (openApproval) return skip(`An approval (${openApproval.kind}) for this run is still open`);
  const queued = db
    .select({ id: agentRunIntents.id })
    .from(agentRunIntents)
    .where(and(eq(agentRunIntents.runId, run.id), inArray(agentRunIntents.kind, BLOCKING_INTENT_KINDS)))
    .all()
    .length;
  if (queued > 0 && db.select().from(agentRunIntents).where(and(eq(agentRunIntents.runId, run.id), inArray(agentRunIntents.kind, BLOCKING_INTENT_KINDS))).all().some((i) => i.claimedAt === null)) {
    return skip("The run has queued work (a resume or an approved action)");
  }
  const ownLock = db.select({ lockKey: agentWorkspaceLocks.lockKey }).from(agentWorkspaceLocks).where(eq(agentWorkspaceLocks.runId, run.id)).get();
  if (ownLock) return skip("The run still holds a workspace lock");

  const isSnapshot = run.workspaceKind === "snapshot_copy";
  const projectRepo = deps.repoPathFor
    ? await deps.repoPathFor(run)
    : await defaultRepoPathFor(db, run, storage, deps.pathDeps);
  let gitRepo: string;
  if (isSnapshot) {
    gitRepo = nodePath.join(snapshotFolderFor(storage.worktreeRoot, run.id), "base");
  } else {
    if (!projectRepo) return skip("The project's folder could not be resolved, so its worktree cannot be removed safely");
    gitRepo = projectRepo;
  }
  const lockPath = projectRepo ?? gitRepo;

  const folderExists = fs.existsSync(worktree);
  if (folderExists) {
    try {
      const status = await gitOut(worktree, ["status", "--porcelain", "--untracked-files=all"]);
      const files = status.split("\n").filter((l) => l.trim() !== "");
      if (files.length > 0) {
        return skip(`The worktree has uncommitted or untracked changes (${files.length} file${files.length === 1 ? "" : "s"}); left as is`);
      }
    } catch (err) {
      return skip(`The worktree state could not be checked: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!isSnapshot) {
    try {
      if (await branchExists(gitRepo, run.branch)) {
        const n = await unmergedCount(gitRepo, run.branch);
        if (n > 0) {
          return skip(`Branch ${run.branch} has ${n} commit${n === 1 ? "" : "s"} that no other branch has; kept (ask to delete it from the run page)`);
        }
      }
    } catch (err) {
      return skip(`The branch could not be checked: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // A lock held by another run or approval on this folder: do not touch the repo now.
  const lock = acquireWorkspaceLock(db, run.id, lockPath, deps.pathDeps);
  if (!lock.ok) return skip(`Another run or approval holds the lock on this folder (${lock.heldBy})`);
  releaseWorkspaceLock(db, run.id, lock.lockKey);

  return {
    action: "remove_worktree",
    reason: isSnapshot
      ? "Dismissed long enough ago; the copy's worktree and throwaway repo will be removed"
      : "Dismissed long enough ago; the worktree is clean and its branch is merged",
    gitRepo,
    lockPath,
  };
}

/* ------------------------------------------------------------------ */
/* Plan                                                                */
/* ------------------------------------------------------------------ */

/**
 * Lists what cleanup would do right now. Returns nothing when the setting is off.
 * Only dismissed runs old enough, with a recorded worktree, appear.
 */
export async function planRetention(db: AgentDatabase, now: Date, deps: RetentionDeps = {}): Promise<RetentionCandidate[]> {
  const storage = await (deps.getStorage ?? defaultStorage)();
  if (storage.retentionDays === null) return [];
  const cutoff = now.getTime() - storage.retentionDays * DAY_MS;

  const rows = db
    .select({ id: agentRuns.id, dismissedAt: agentRuns.dismissedAt })
    .from(agentRuns)
    .where(and(isNotNull(agentRuns.dismissedAt), isNotNull(agentRuns.workspacePath)))
    .all();

  const plan: RetentionCandidate[] = [];
  for (const row of rows) {
    const dismissedMs = row.dismissedAt ? Date.parse(row.dismissedAt) : Number.NaN;
    if (!Number.isFinite(dismissedMs) || dismissedMs > cutoff) continue;
    const run = await getRun(db, row.id);
    if (!run || !run.workspacePath || !run.dismissedAt) continue;
    const verdict = await assess(db, run, storage, deps);
    plan.push({
      runId: run.id,
      worktreePath: run.workspacePath,
      branch: run.branch,
      action: verdict.action,
      reason: verdict.reason,
      workspaceKind: run.workspaceKind,
      dismissedAt: run.dismissedAt,
    });
  }
  return plan;
}

/* ------------------------------------------------------------------ */
/* Apply                                                               */
/* ------------------------------------------------------------------ */

export interface ApplyRetentionDeps extends RetentionDeps {
  db: AgentDatabase;
  now?: () => Date;
}

/**
 * Acts on the "remove_worktree" entries of a plan, re-checking each one first. A run
 * that is no longer safe is skipped. Never forces anything.
 */
export async function applyRetention(plan: RetentionCandidate[], deps: ApplyRetentionDeps): Promise<ApplyRetentionResult> {
  const { db } = deps;
  const result: ApplyRetentionResult = { removed: [], skipped: [] };
  const storage = await (deps.getStorage ?? defaultStorage)();
  if (storage.retentionDays === null) {
    return { removed: [], skipped: plan.map((c) => ({ runId: c.runId, reason: "Cleanup is off" })) };
  }
  const cutoff = (deps.now ?? (() => new Date()))().getTime() - storage.retentionDays * DAY_MS;

  for (const candidate of plan) {
    if (candidate.action !== "remove_worktree") {
      result.skipped.push({ runId: candidate.runId, reason: candidate.reason });
      continue;
    }
    const run = await getRun(db, candidate.runId);
    const dismissedMs = run?.dismissedAt ? Date.parse(run.dismissedAt) : Number.NaN;
    if (!run || !run.workspacePath || !Number.isFinite(dismissedMs) || dismissedMs > cutoff) {
      result.skipped.push({ runId: candidate.runId, reason: "The run is no longer dismissed long enough ago" });
      continue;
    }
    if (run.workspacePath !== candidate.worktreePath) {
      result.skipped.push({ runId: candidate.runId, reason: "The run's worktree changed since the plan" });
      continue;
    }
    const verdict = await assess(db, run, storage, deps);
    if (verdict.action !== "remove_worktree" || !verdict.gitRepo || !verdict.lockPath || !run.branch) {
      result.skipped.push({ runId: run.id, reason: verdict.reason });
      continue;
    }
    const lock = acquireWorkspaceLock(db, run.id, verdict.lockPath, deps.pathDeps);
    if (!lock.ok) {
      result.skipped.push({ runId: run.id, reason: `Another run or approval holds the lock on this folder (${lock.heldBy})` });
      continue;
    }
    try {
      const outcome = await removeOne(db, run, run.workspacePath, run.branch, verdict.gitRepo, storage.worktreeRoot);
      if (outcome.ok) {
        result.removed.push({
          runId: run.id,
          reason: outcome.note,
          branchDeleted: outcome.branchDeleted,
          snapshotFolderRemoved: outcome.snapshotFolderRemoved,
        });
      } else {
        result.skipped.push({ runId: run.id, reason: outcome.reason });
      }
    } catch (err) {
      result.skipped.push({ runId: run.id, reason: `Cleanup failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      releaseWorkspaceLock(db, run.id, lock.lockKey);
    }
  }
  return result;
}

type RemoveOutcome =
  | { ok: true; note: string; branchDeleted: boolean; snapshotFolderRemoved: boolean }
  | { ok: false; reason: string };

async function removeOne(
  db: AgentDatabase,
  run: AgentRunRecord,
  worktreePath: string,
  branch: string,
  gitRepo: string,
  worktreeRoot: string,
): Promise<RemoveOutcome> {
  const removed = await removeRunWorktree({ repoPath: gitRepo, worktreePath, worktreeRoot });
  if (!removed.ok) return { ok: false, reason: `Could not remove the worktree: ${removed.reason}` };

  const isSnapshot = run.workspaceKind === "snapshot_copy";
  let branchDeleted = false;
  let snapshotFolderRemoved = false;
  let note = "worktree removed";

  if (isSnapshot) {
    // The throwaway base repo goes too; its branch check does not apply. Only this run's folder under snap/.
    const folder = snapshotFolderFor(worktreeRoot, run.id);
    if (isUnderSnap(worktreeRoot, folder) && fs.existsSync(folder)) {
      fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      snapshotFolderRemoved = !fs.existsSync(folder);
    }
    note = snapshotFolderRemoved ? "worktree and snapshot copy removed" : "worktree removed; the snapshot folder could not be fully removed";
  } else {
    try {
      if (await branchExists(gitRepo, branch)) {
        await gitOut(gitRepo, ["branch", "-d", branch]); // never -D
        branchDeleted = true;
      }
    } catch {
      note = "worktree removed; the branch was kept (Git does not consider it merged into the checked-out branch)";
    }
    if (branchDeleted) note = "worktree removed and merged branch deleted";
  }

  db.update(agentRuns).set({ workspacePath: null }).where(eq(agentRuns.id, run.id)).run();
  await appendEvent(db, {
    runId: run.id,
    stage: null,
    agent: "system",
    kind: "warning",
    payload: {
      message: `Cleanup: ${note} (the run was dismissed ${run.dismissedAt ?? "earlier"})`,
      cleanup: true,
      branch,
      branchDeleted,
      snapshotFolderRemoved,
    },
  });
  return { ok: true, note, branchDeleted, snapshotFolderRemoved };
}

function isUnderSnap(worktreeRoot: string, folder: string): boolean {
  const snap = normalizeAny(nodePath.join(worktreeRoot, "command-center", "snap"));
  const child = normalizeAny(folder);
  return nodePath.dirname(child) === snap;
}

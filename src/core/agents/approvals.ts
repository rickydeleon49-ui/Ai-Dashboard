/**
 * Approval-gated actions on a finished run (Release AW.4, AW4-08, design §16.4 row 7).
 *
 * Each action is PREVIEWED (requestApproval), APPROVED or rejected by you
 * (decideApproval), and only then EXECUTED BY THE RUNNER from an
 * `approval_execute` intent (executeApproval). The API only ever calls
 * requestApproval and decideApproval; nothing runs inside a request. Every step
 * appends a run event.
 *
 * Kinds: merge into a branch you choose, push the run branch, open a DRAFT pull
 * request (never merged by the app), apply a snapshot run back to the original
 * folder, and delete a worktree whose branch has unmerged commits.
 *
 * Execution re-checks everything the preview showed: the run branch must still be
 * at the previewed commit, a merge needs a clean checkout of the chosen branch and
 * takes the workspace lock for the repo, and nothing is ever forced.
 */
import nodePath from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { agentRunApprovals, agentRunIntents, projects, type AgentRunApprovalRow } from "@/db/schema";
import { createId } from "@/lib/ids";
import { appendEvent, type AgentDatabase } from "./events";
import { defaultCreateDraftPr, type CreateDraftPr } from "./github-pr";
import { getPolicy } from "./policy";
import { buildPrBody } from "./pr-body";
import {
  acquireWorkspaceLock,
  checkRootAvailable,
  getAgentStorageSettings,
  releaseWorkspaceLock,
  resolveProjectPath,
  type AgentStorageSettings,
  type PathDeps,
} from "./roots";
import { getRun, type AgentRunRecord } from "./runs";
import type { RunOutcome } from "./orchestrator";
import { applyBack, planApplyBack, snapshotBasePathFor, type ApplyBackEntry } from "./snapshot";
import { execGit, GitError, removeRunWorktree, shortRunId } from "./workspace";

export const APPROVAL_KINDS = ["merge", "push", "draft_pr", "apply_back", "delete_worktree"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "executing", "done", "failed"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** Statuses that count as "one pending approval per run and kind". */
export const OPEN_STATUSES: ApprovalStatus[] = ["pending", "approved", "executing"];

const FINISHED_RUN_STATUSES = ["succeeded", "failed", "stopped"];

export type ApprovalErrorCode = "not_found" | "invalid" | "conflict" | "refused";

export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;
  constructor(code: ApprovalErrorCode, message: string) {
    super(message);
    this.name = "ApprovalError";
    this.code = code;
  }
}

/** Where things live for one run: the original project folder and the app's storage roots. */
export interface ApprovalEnv {
  /** The real path of the project's original folder (a Git repo for git_worktree runs). */
  repoPath: string;
  worktreeRoot: string;
  runStore: string;
}

export interface ApprovalExecDeps {
  createDraftPr?: CreateDraftPr;
  now?: () => Date;
  /** Test seam: called while the workspace lock is held, before the action itself runs. */
  afterLock?: () => void | Promise<void>;
  pathDeps?: PathDeps;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  preview: Record<string, unknown>;
  target: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  requestedAt: string;
  decidedAt: string | null;
  executedAt: string | null;
}

/* ------------------------------------------------------------------ */
/* Targets                                                             */
/* ------------------------------------------------------------------ */

const branchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._/-]+$/, "Branch names may only use letters, numbers, . _ / and -")
  .refine((b) => !b.startsWith("-") && !b.includes("..") && !b.endsWith("/") && !b.endsWith(".lock"), "Invalid branch name");

const remoteNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, "Remote names may only use letters, numbers, . _ and -")
  .refine((r) => !r.startsWith("-"), "Invalid remote name");

export const TARGET_SCHEMAS = {
  merge: z.object({ targetBranch: branchNameSchema }).strict(),
  push: z.object({ remote: remoteNameSchema.optional() }).strict(),
  draft_pr: z
    .object({
      base: branchNameSchema,
      remote: remoteNameSchema.optional(),
      title: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  apply_back: z.object({}).strict(),
  delete_worktree: z.object({}).strict(),
} as const;

export const approvalRequestSchema = z
  .object({
    kind: z.enum(APPROVAL_KINDS),
    target: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const approvalDecisionSchema = z.object({ decision: z.enum(["approve", "reject"]) }).strict();

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toRecord(row: AgentRunApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind as ApprovalKind,
    status: row.status as ApprovalStatus,
    preview: parseObject(row.preview) ?? {},
    target: parseObject(row.target) ?? {},
    result: parseObject(row.result),
    error: row.error ?? null,
    requestedAt: row.requestedAt,
    decidedAt: row.decidedAt ?? null,
    executedAt: row.executedAt ?? null,
  };
}

export function getApproval(db: AgentDatabase, id: string): ApprovalRecord | null {
  const row = db.select().from(agentRunApprovals).where(eq(agentRunApprovals.id, id)).get();
  return row ? toRecord(row) : null;
}

export function listApprovals(db: AgentDatabase, runId: string): ApprovalRecord[] {
  return db
    .select()
    .from(agentRunApprovals)
    .where(eq(agentRunApprovals.runId, runId))
    .orderBy(desc(agentRunApprovals.requestedAt), desc(agentRunApprovals.id))
    .all()
    .map(toRecord);
}

async function logApproval(
  db: AgentDatabase,
  runId: string,
  approvalId: string,
  kind: ApprovalKind,
  phase: "requested" | "approved" | "rejected" | "executing" | "done" | "failed",
  extra: Record<string, unknown> = {},
): Promise<void> {
  await appendEvent(db, { runId, stage: null, agent: "system", kind: "approval", payload: { approvalId, kind, phase, ...extra } });
}

/* ------------------------------------------------------------------ */
/* Git helpers                                                         */
/* ------------------------------------------------------------------ */

const MAX_COMMITS_LISTED = 50;
const MAX_FILES_LISTED = 500;

export interface CommitLine {
  sha: string;
  subject: string;
}

async function gitOut(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
  return (await execGit(args, { cwd, timeoutMs })).stdout;
}

async function refSha(cwd: string, ref: string): Promise<string | null> {
  try {
    const out = await gitOut(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

function parseCommitLines(out: string): CommitLine[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const space = l.indexOf(" ");
      return space === -1 ? { sha: l, subject: "" } : { sha: l.slice(0, space), subject: l.slice(space + 1) };
    });
}

async function commitsBetween(cwd: string, from: string, to: string): Promise<{ count: number; commits: CommitLine[] }> {
  const count = Number.parseInt((await gitOut(cwd, ["rev-list", "--count", `${from}..${to}`])).trim(), 10) || 0;
  const commits = parseCommitLines(
    await gitOut(cwd, ["log", "--format=%H %s", `--max-count=${MAX_COMMITS_LISTED}`, `${from}..${to}`]),
  );
  return { count, commits };
}

async function trackedChanges(cwd: string): Promise<string[]> {
  const out = await gitOut(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  return out
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(0, MAX_FILES_LISTED);
}

async function currentBranch(cwd: string): Promise<string | null> {
  try {
    return (await gitOut(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

/** Dry-run merge with `git merge-tree`; conflicts is null when this Git cannot do it. */
async function mergeConflicts(cwd: string, targetSha: string, runSha: string): Promise<{ conflicts: boolean | null; files: string[] }> {
  try {
    await execGit(["merge-tree", "--write-tree", "--name-only", "--no-messages", targetSha, runSha], { cwd });
    return { conflicts: false, files: [] };
  } catch (err) {
    if (err instanceof GitError && err.code === 1) {
      const lines = err.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      return { conflicts: true, files: lines.slice(1, MAX_FILES_LISTED + 1) };
    }
    return { conflicts: null, files: [] };
  }
}

function stripCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i, "$1");
}

async function remoteUrl(cwd: string, remote: string): Promise<string> {
  try {
    const url = (await gitOut(cwd, ["remote", "get-url", remote])).trim();
    if (url) return url;
  } catch {
    // fall through
  }
  throw new ApprovalError("invalid", `Remote "${remote}" does not exist in this project`);
}

function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  const m = /github\.com[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(stripCredentials(url));
  return m && m[1] && m[2] ? { owner: m[1], repo: m[2] } : null;
}

/* ------------------------------------------------------------------ */
/* Run context                                                         */
/* ------------------------------------------------------------------ */

interface RunGit {
  run: AgentRunRecord;
  /** The repo that holds the run branch: the project (git_worktree) or the snapshot's base repo. */
  gitRepo: string;
  branch: string;
}

function assertFinished(run: AgentRunRecord): void {
  if (!FINISHED_RUN_STATUSES.includes(run.status)) {
    throw new ApprovalError("conflict", `Only a finished run can have approvals (this run is ${run.status})`);
  }
}

function runGit(run: AgentRunRecord, env: ApprovalEnv): RunGit {
  if (!run.branch || !/^agent\/[0-9a-f]{12}$/.test(run.branch)) {
    throw new ApprovalError("invalid", "This run has no run branch");
  }
  const gitRepo =
    run.workspaceKind === "snapshot_copy" ? snapshotBasePathFor(env.worktreeRoot, run.id) : env.repoPath;
  return { run, gitRepo, branch: run.branch };
}

function requireGitWorktreeRun(run: AgentRunRecord, kind: ApprovalKind): void {
  if (run.workspaceKind === "snapshot_copy") {
    throw new ApprovalError(
      "invalid",
      `${kind} is only for runs in a Git project; this run worked on a copy of a folder that is not a Git repository`,
    );
  }
}

async function runShaOf(rg: RunGit): Promise<string> {
  const sha = await refSha(rg.gitRepo, `refs/heads/${rg.branch}`);
  if (!sha) throw new ApprovalError("refused", `The run branch ${rg.branch} no longer exists`);
  return sha;
}

function roleLabel(role: { provider: string; model?: string | undefined } | undefined): string | null {
  if (!role) return null;
  return role.model ? `${role.provider} (${role.model})` : role.provider;
}

/* ------------------------------------------------------------------ */
/* Previews                                                            */
/* ------------------------------------------------------------------ */

type Target = Record<string, unknown>;

async function previewMerge(rg: RunGit, env: ApprovalEnv, target: { targetBranch: string }): Promise<Target> {
  requireGitWorktreeRun(rg.run, "merge");
  const runSha = await runShaOf(rg);
  const targetSha = await refSha(env.repoPath, `refs/heads/${target.targetBranch}`);
  if (!targetSha) throw new ApprovalError("invalid", `Branch "${target.targetBranch}" does not exist in the project`);
  const checkedOut = await currentBranch(env.repoPath);
  if (checkedOut !== target.targetBranch) {
    throw new ApprovalError(
      "invalid",
      `"${target.targetBranch}" is not the branch checked out in your project (${checkedOut ?? "detached HEAD"}); check it out first, the app never switches your checkout`,
    );
  }
  const ahead = await commitsBetween(env.repoPath, targetSha, runSha);
  const merge = await mergeConflicts(env.repoPath, targetSha, runSha);
  const dirtyFiles = await trackedChanges(env.repoPath);
  return {
    targetBranch: target.targetBranch,
    targetSha,
    runBranch: rg.branch,
    runSha,
    commitsAhead: ahead.count,
    commits: ahead.commits,
    conflicts: merge.conflicts,
    conflictFiles: merge.files,
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
  };
}

async function previewPush(rg: RunGit, env: ApprovalEnv, target: { remote?: string | undefined }): Promise<Target> {
  requireGitWorktreeRun(rg.run, "push");
  const remote = target.remote ?? "origin";
  const url = await remoteUrl(env.repoPath, remote);
  const runSha = await runShaOf(rg);
  const remoteSha = await refSha(env.repoPath, `refs/remotes/${remote}/${rg.branch}`);
  const from = remoteSha ?? rg.run.baseRef;
  const ahead = from ? await commitsBetween(env.repoPath, from, runSha) : { count: 0, commits: [] };
  return {
    remote,
    remoteUrl: stripCredentials(url),
    branch: rg.branch,
    runSha,
    remoteSha,
    commitsAhead: ahead.count,
    commits: ahead.commits,
    force: false,
  };
}

async function previewDraftPr(
  rg: RunGit,
  env: ApprovalEnv,
  target: { base: string; remote?: string | undefined; title?: string | undefined },
): Promise<Target> {
  requireGitWorktreeRun(rg.run, "draft_pr");
  const remote = target.remote ?? "origin";
  const url = await remoteUrl(env.repoPath, remote);
  const repo = parseGitHubRepo(url);
  if (!repo) throw new ApprovalError("invalid", `Remote "${remote}" is not a GitHub repository`);
  const outcome = rg.run.outcome as RunOutcome | null;
  if (!outcome || typeof outcome !== "object" || !outcome.facts) {
    throw new ApprovalError("invalid", "This run has no recorded outcome to build a description from");
  }
  const runSha = await runShaOf(rg);
  const changedFiles = rg.run.baseRef
    ? (await gitOut(env.repoPath, ["diff", "--name-only", rg.run.baseRef, runSha]))
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, MAX_FILES_LISTED)
    : [];
  const task = rg.run.request.task ?? "";
  const title = target.title ?? ((task.trim().split(/\r?\n/)[0] ?? "").trim().slice(0, 200) || `Agent run ${shortRunId(rg.run.id)}`);
  const body = buildPrBody({
    title,
    implementer: roleLabel(rg.run.request.roles?.implementer) ?? "unknown",
    reviewer: roleLabel(rg.run.request.roles?.reviewer),
    outcome,
    changedFiles,
    agentSummary: null,
    taskUrl: null,
    runUrl: null,
  });
  return {
    remote,
    owner: repo.owner,
    repo: repo.repo,
    head: rg.branch,
    base: target.base,
    runSha,
    title,
    body,
    changedFiles,
    draft: true,
  };
}

async function previewApplyBack(db: AgentDatabase, rg: RunGit, env: ApprovalEnv): Promise<Target> {
  if (rg.run.workspaceKind !== "snapshot_copy") {
    throw new ApprovalError("invalid", "Apply-back is only for runs on a copy of a folder that is not a Git repository");
  }
  if (!rg.run.workspacePath || !rg.run.baseRef) throw new ApprovalError("invalid", "This run has no workspace to apply back");
  const runSha = await runShaOf(rg);
  const entries = await planApplyBack({
    runWorktree: rg.run.workspacePath,
    baseSha: rg.run.baseRef,
    sourceDir: env.repoPath,
    excludedPaths: getPolicy(db, rg.run.projectId).excludedPaths,
  }).catch((err: unknown) => {
    throw new ApprovalError("invalid", err instanceof Error ? err.message : String(err));
  });
  if (entries.length === 0) throw new ApprovalError("invalid", "The run changed nothing, so there is nothing to apply back");
  return {
    runSha,
    baseSha: rg.run.baseRef,
    sourceDir: env.repoPath,
    entries,
    writes: entries.filter((e) => e.action === "write").length,
    deletes: entries.filter((e) => e.action === "delete").length,
  };
}

async function previewDeleteWorktree(rg: RunGit): Promise<Target> {
  if (!rg.run.workspacePath) throw new ApprovalError("invalid", "This run has no worktree");
  const runSha = await runShaOf(rg);
  const unmerged = parseCommitLines(
    await gitOut(rg.gitRepo, [
      "log",
      "--format=%H %s",
      `--max-count=${MAX_COMMITS_LISTED}`,
      `refs/heads/${rg.branch}`,
      "--not",
      `--exclude=${rg.branch}`,
      "--branches",
      "--remotes",
    ]),
  );
  let uncommitted: string[] = [];
  try {
    uncommitted = await trackedChanges(rg.run.workspacePath);
  } catch {
    // the folder may already be gone
  }
  return {
    branch: rg.branch,
    runSha,
    worktreePath: rg.run.workspacePath,
    unmergedCommits: unmerged,
    uncommittedFiles: uncommitted,
    branchKept: true,
  };
}

/* ------------------------------------------------------------------ */
/* Request                                                             */
/* ------------------------------------------------------------------ */

/**
 * Builds the preview for `kind` and stores a `pending` approval. Refuses a run that
 * is not finished, a kind that does not fit the run, and a second open approval of
 * the same kind on the same run.
 */
export async function requestApproval(
  db: AgentDatabase,
  runId: string,
  kind: ApprovalKind,
  rawTarget: unknown,
  env: ApprovalEnv,
): Promise<ApprovalRecord> {
  if (!(APPROVAL_KINDS as readonly string[]).includes(kind)) throw new ApprovalError("invalid", `Unknown approval kind "${kind}"`);
  const run = await getRun(db, runId);
  if (!run) throw new ApprovalError("not_found", "Agent run not found");
  assertFinished(run);
  const parsed = TARGET_SCHEMAS[kind].safeParse(rawTarget ?? {});
  if (!parsed.success) {
    throw new ApprovalError("invalid", parsed.error.issues.map((i) => `${i.path.join(".") || "target"}: ${i.message}`).join("; "));
  }
  const target = parsed.data as Record<string, unknown>;

  const findOpen = (reader: Pick<AgentDatabase, "select">) =>
    reader
      .select({ id: agentRunApprovals.id })
      .from(agentRunApprovals)
      .where(
        and(
          eq(agentRunApprovals.runId, runId),
          eq(agentRunApprovals.kind, kind),
          inArray(agentRunApprovals.status, OPEN_STATUSES),
        ),
      )
      .get();
  const dupMessage = `This run already has a ${kind} approval that is waiting or running`;
  if (findOpen(db)) throw new ApprovalError("conflict", dupMessage);

  const rg = runGit(run, env);
  let preview: Target;
  switch (kind) {
    case "merge":
      preview = await previewMerge(rg, env, target as { targetBranch: string });
      break;
    case "push":
      preview = await previewPush(rg, env, target as { remote?: string });
      break;
    case "draft_pr":
      preview = await previewDraftPr(rg, env, target as { base: string; remote?: string; title?: string });
      break;
    case "apply_back":
      preview = await previewApplyBack(db, rg, env);
      break;
    case "delete_worktree":
      preview = await previewDeleteWorktree(rg);
      break;
  }

  const id = createId("approval");
  db.transaction((tx) => {
    // Re-checked inside the transaction: a concurrent request cannot slip a duplicate in.
    if (findOpen(tx as unknown as AgentDatabase)) throw new ApprovalError("conflict", dupMessage);
    tx.insert(agentRunApprovals)
      .values({ id, runId, kind, status: "pending", preview: JSON.stringify(preview), target: JSON.stringify(target) })
      .run();
  });
  await logApproval(db, runId, id, kind, "requested");
  const created = getApproval(db, id);
  if (!created) throw new Error(`Failed to create approval "${id}"`);
  return created;
}

/* ------------------------------------------------------------------ */
/* Decide                                                              */
/* ------------------------------------------------------------------ */

/**
 * Approve or reject a pending approval. Approving only queues an `approval_execute`
 * intent in the same transaction: the runner does the work, never this call.
 */
export async function decideApproval(
  db: AgentDatabase,
  approvalId: string,
  decision: "approve" | "reject",
  now: () => Date = () => new Date(),
): Promise<ApprovalRecord> {
  const row = getApproval(db, approvalId);
  if (!row) throw new ApprovalError("not_found", "Approval not found");
  const decidedAt = now().toISOString();
  const nextStatus: ApprovalStatus = decision === "approve" ? "approved" : "rejected";
  db.transaction((tx) => {
    const changed = tx
      .update(agentRunApprovals)
      .set({ status: nextStatus, decidedAt })
      .where(and(eq(agentRunApprovals.id, approvalId), eq(agentRunApprovals.status, "pending")))
      .returning({ id: agentRunApprovals.id })
      .all();
    if (changed.length === 0) {
      throw new ApprovalError("conflict", `This approval is already ${row.status}`);
    }
    if (decision === "approve") {
      tx.insert(agentRunIntents)
        .values({ id: createId("intent"), runId: row.runId, kind: "approval_execute", payload: JSON.stringify({ approvalId }) })
        .run();
    }
  });
  await logApproval(db, row.runId, approvalId, row.kind, decision === "approve" ? "approved" : "rejected");
  const updated = getApproval(db, approvalId);
  if (!updated) throw new Error(`Approval "${approvalId}" vanished`);
  return updated;
}

/* ------------------------------------------------------------------ */
/* Execute (runner only)                                               */
/* ------------------------------------------------------------------ */

function str(preview: Record<string, unknown>, key: string): string {
  const v = preview[key];
  if (typeof v !== "string") throw new ApprovalError("refused", `The stored preview is missing "${key}"; request a new preview`);
  return v;
}

async function assertBranchUnmoved(rg: RunGit, preview: Record<string, unknown>): Promise<string> {
  const previewed = str(preview, "runSha");
  const now = await runShaOf(rg);
  if (now !== previewed) {
    throw new ApprovalError(
      "refused",
      `The run branch moved since the preview (${previewed.slice(0, 8)} to ${now.slice(0, 8)}); request a new preview`,
    );
  }
  return now;
}

async function withRepoLock<T>(
  db: AgentDatabase,
  runId: string,
  repoPath: string,
  deps: ApprovalExecDeps,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = acquireWorkspaceLock(db, runId, repoPath, deps.pathDeps);
  if (!lock.ok) {
    throw new ApprovalError("refused", `Another run or approval holds the lock on this folder (${lock.heldBy}); try again when it finishes`);
  }
  try {
    await deps.afterLock?.();
    return await fn();
  } finally {
    releaseWorkspaceLock(db, runId, lock.lockKey);
  }
}

async function execMerge(db: AgentDatabase, rg: RunGit, env: ApprovalEnv, a: ApprovalRecord, deps: ApprovalExecDeps): Promise<Target> {
  requireGitWorktreeRun(rg.run, "merge");
  const targetBranch = str(a.preview, "targetBranch");
  const targetSha = str(a.preview, "targetSha");
  return withRepoLock(db, rg.run.id, env.repoPath, deps, async () => {
    const runSha = await assertBranchUnmoved(rg, a.preview);
    const checkedOut = await currentBranch(env.repoPath);
    if (checkedOut !== targetBranch) {
      throw new ApprovalError("refused", `"${targetBranch}" is no longer the branch checked out in your project`);
    }
    const head = await refSha(env.repoPath, "HEAD");
    if (head !== targetSha) {
      throw new ApprovalError("refused", `"${targetBranch}" moved since the preview; request a new preview`);
    }
    const dirty = await trackedChanges(env.repoPath);
    if (dirty.length > 0) {
      throw new ApprovalError("refused", `Your checkout has uncommitted changes (${dirty.length} file${dirty.length === 1 ? "" : "s"}); commit or stash them first`);
    }
    try {
      await execGit(
        // Your own Git identity authors the merge in your repo (no runner identity override).
        ["merge", "--no-ff", "--no-edit", "-m", `Merge ${rg.branch} (Command Center)`, runSha],
        { cwd: env.repoPath, timeoutMs: 120_000 },
      );
    } catch (err) {
      try {
        await execGit(["merge", "--abort"], { cwd: env.repoPath });
      } catch {
        // nothing to abort
      }
      throw new ApprovalError("refused", `The merge failed and was aborted: ${err instanceof Error ? err.message : String(err)}`);
    }
    const mergeSha = (await gitOut(env.repoPath, ["rev-parse", "HEAD"])).trim();
    return { targetBranch, runSha, mergeSha };
  });
}

async function execPush(rg: RunGit, env: ApprovalEnv, a: ApprovalRecord): Promise<Target> {
  requireGitWorktreeRun(rg.run, "push");
  const remote = str(a.preview, "remote");
  const runSha = await assertBranchUnmoved(rg, a.preview);
  const url = stripCredentials(await remoteUrl(env.repoPath, remote));
  if (url !== str(a.preview, "remoteUrl")) {
    throw new ApprovalError("refused", `Remote "${remote}" points somewhere else than at the preview; request a new preview`);
  }
  // Never forced: no "+" in the refspec and no --force flag.
  await execGit(["push", remote, `refs/heads/${rg.branch}:refs/heads/${rg.branch}`], { cwd: env.repoPath, timeoutMs: 180_000 });
  return { remote, branch: rg.branch, runSha, remoteUrl: url };
}

async function execDraftPr(rg: RunGit, env: ApprovalEnv, a: ApprovalRecord, deps: ApprovalExecDeps): Promise<Target> {
  requireGitWorktreeRun(rg.run, "draft_pr");
  const remote = str(a.preview, "remote");
  const runSha = await assertBranchUnmoved(rg, a.preview);
  const listed = (
    await gitOut(env.repoPath, ["ls-remote", "--heads", remote, `refs/heads/${rg.branch}`], 60_000)
  ).trim();
  const remoteSha = listed.split(/\s+/)[0] ?? "";
  if (remoteSha !== runSha) {
    throw new ApprovalError("refused", `The run branch is not on "${remote}" at the previewed commit; approve a push first`);
  }
  const create = deps.createDraftPr ?? defaultCreateDraftPr;
  const pr = await create({
    owner: str(a.preview, "owner"),
    repo: str(a.preview, "repo"),
    head: str(a.preview, "head"),
    base: str(a.preview, "base"),
    title: str(a.preview, "title"),
    body: str(a.preview, "body"),
  });
  return { url: pr.url, number: pr.number, draft: true, runSha };
}

async function execApplyBack(db: AgentDatabase, rg: RunGit, env: ApprovalEnv, a: ApprovalRecord, deps: ApprovalExecDeps): Promise<Target> {
  if (rg.run.workspaceKind !== "snapshot_copy" || !rg.run.workspacePath) {
    throw new ApprovalError("refused", "Apply-back is only for runs on a copy of a folder that is not a Git repository");
  }
  const entries = a.preview.entries as ApplyBackEntry[] | undefined;
  if (!Array.isArray(entries) || entries.length === 0) throw new ApprovalError("refused", "The stored preview has no plan; request a new preview");
  const runWorktree = rg.run.workspacePath;
  return withRepoLock(db, rg.run.id, env.repoPath, deps, async () => {
    await assertBranchUnmoved(rg, a.preview);
    const result = await applyBack(entries, {
      sourceDir: env.repoPath,
      runWorktree,
      backupRoot: nodePath.join(env.runStore, "backups"),
      now: (deps.now ?? (() => new Date()))(),
      shortId: shortRunId(rg.run.id),
      excludedPaths: getPolicy(db, rg.run.projectId).excludedPaths,
    });
    return { written: result.written, deleted: result.deleted, backupDir: result.backupDir };
  });
}

async function execDeleteWorktree(rg: RunGit, env: ApprovalEnv, a: ApprovalRecord): Promise<Target> {
  if (!rg.run.workspacePath) throw new ApprovalError("refused", "This run has no worktree");
  await assertBranchUnmoved(rg, a.preview);
  const removed = await removeRunWorktree({
    repoPath: rg.gitRepo,
    worktreePath: rg.run.workspacePath,
    worktreeRoot: env.worktreeRoot,
  });
  if (!removed.ok) throw new ApprovalError("refused", `Could not remove the worktree: ${removed.reason}`);
  return { removed: rg.run.workspacePath, branchKept: rg.branch };
}

function nowIso(deps: ApprovalExecDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

/**
 * Executes an APPROVED approval. Called by the runner for an `approval_execute`
 * intent, never by an API route. Throws (changing nothing) when the row is not
 * approved; otherwise returns the finished record, `done` or `failed`.
 */
export async function executeApproval(
  db: AgentDatabase,
  approvalId: string,
  env: ApprovalEnv,
  deps: ApprovalExecDeps = {},
): Promise<ApprovalRecord> {
  const existing = getApproval(db, approvalId);
  if (!existing) throw new ApprovalError("not_found", "Approval not found");
  const claimed = db
    .update(agentRunApprovals)
    .set({ status: "executing", executedAt: nowIso(deps) })
    .where(and(eq(agentRunApprovals.id, approvalId), eq(agentRunApprovals.status, "approved")))
    .returning({ id: agentRunApprovals.id })
    .all();
  if (claimed.length === 0) {
    throw new ApprovalError("refused", `Approval is ${existing.status}, not approved; nothing was run`);
  }
  const a = getApproval(db, approvalId) as ApprovalRecord;
  await logApproval(db, a.runId, a.id, a.kind, "executing");

  try {
    const run = await getRun(db, a.runId);
    if (!run) throw new ApprovalError("refused", "The run no longer exists");
    assertFinished(run);
    const rg = runGit(run, env);
    let result: Target;
    switch (a.kind) {
      case "merge":
        result = await execMerge(db, rg, env, a, deps);
        break;
      case "push":
        result = await execPush(rg, env, a);
        break;
      case "draft_pr":
        result = await execDraftPr(rg, env, a, deps);
        break;
      case "apply_back":
        result = await execApplyBack(db, rg, env, a, deps);
        break;
      case "delete_worktree":
        result = await execDeleteWorktree(rg, env, a);
        break;
    }
    db.update(agentRunApprovals)
      .set({ status: "done", result: JSON.stringify(result) })
      .where(eq(agentRunApprovals.id, a.id))
      .run();
    await logApproval(db, a.runId, a.id, a.kind, "done", { result });
  } catch (err) {
    await failApproval(db, a.id, err instanceof Error ? err.message : String(err));
  }
  return getApproval(db, approvalId) as ApprovalRecord;
}

/** Marks an approved or executing approval failed (also used by the runner when it cannot even start one). */
export async function failApproval(db: AgentDatabase, approvalId: string, message: string): Promise<void> {
  const failed = db
    .update(agentRunApprovals)
    .set({ status: "failed", error: message.slice(0, 2000), executedAt: new Date().toISOString() })
    .where(and(eq(agentRunApprovals.id, approvalId), inArray(agentRunApprovals.status, ["approved", "executing"])))
    .returning({ runId: agentRunApprovals.runId, kind: agentRunApprovals.kind })
    .all();
  const row = failed[0];
  if (row) await logApproval(db, row.runId, approvalId, row.kind as ApprovalKind, "failed", { error: message.slice(0, 500) });
}

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

/** The project's real folder plus the storage roots, or an ApprovalError when the path is refused. */
export async function approvalEnvFor(
  db: AgentDatabase,
  run: AgentRunRecord,
  getStorage: () => Promise<AgentStorageSettings> = () => getAgentStorageSettings(),
  pathDeps?: PathDeps,
): Promise<ApprovalEnv> {
  const project = db.select().from(projects).where(eq(projects.id, run.projectId)).get();
  if (!project) throw new ApprovalError("refused", "The run's project no longer exists");
  if (!project.localPath) throw new ApprovalError("refused", "The project has no local path");
  const storage = await getStorage();
  const resolved = resolveProjectPath(project.localPath, storage.workspaceRoots, pathDeps);
  if (!resolved.ok) throw new ApprovalError("refused", `Project path refused: ${resolved.reason}`);
  const available = checkRootAvailable(resolved.root);
  if (!available.ok) throw new ApprovalError("refused", `Project path refused: ${available.reason}`);
  return { repoPath: resolved.realPath, worktreeRoot: storage.worktreeRoot, runStore: storage.runStore };
}

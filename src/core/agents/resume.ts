/**
 * Explicit Resume of an interrupted, failed or stopped run (Release AW.4, AW4-07, design §7 "Resume").
 *
 * Resume is a user action. It starts a NEW attempt from the last completed stage
 * boundary and re-uses the run's worktree; it never picks up mid-command. The API
 * only calls requestResume (check, then queue a `resume` intent); the runner
 * re-checks and does the work (runner/index.ts), exactly like approval_execute.
 *
 * A resume is refused when the worktree changed outside the run: HEAD must be the
 * run's last stage commit (or its base commit when it made none) and the tree must
 * be clean, ignoring the run's excluded paths and heavy folders.
 */
import fs from "node:fs";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { agentRunApprovals, agentRunEvents, agentRunIntents, agentRuns } from "@/db/schema";
import { appendEvent, type AgentDatabase } from "./events";
import { OPEN_STATUSES } from "./approvals";
import { getPolicy, toRunPolicy } from "./policy";
import { acquireWorkspaceLock, releaseWorkspaceLock, type PathDeps } from "./roots";
import { createIntent } from "./runs";
import { SNAPSHOT_SKIP_NAMES } from "./snapshot";
import { plannerOutputSchema, runRequestSchema, type PlannerOutput } from "./schema";
import type { ResumeContext, ResumeStartAt } from "./orchestrator";
import type { RunStage, RunStatus, WorkspaceKind } from "./types";
import { execGit, matchGlob, shortRunId } from "./workspace";

/** Run statuses a resume may start from. */
export const RESUMABLE_STATUSES: readonly RunStatus[] = ["interrupted", "failed", "stopped"];

/** Most paths named in a refusal message. */
export const MAX_LISTED_PATHS = 10;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResumeSessionIds {
  /** The implementer's recorded session or conversation id (Claude Code, Antigravity). */
  implementer?: string;
  /** Planner and reviewer calls do not record a session id today; kept so a later round can fill them. */
  planner?: string;
  reviewer?: string;
}

export type ResumeCheck =
  | { ok: true; fromStage: RunStage; startAt: ResumeStartAt; sessionIds: ResumeSessionIds; context: ResumeContext }
  | { ok: false; reason: string };

export interface ResumeDeps {
  pathDeps?: PathDeps;
}

function listPaths(paths: string[]): string {
  const shown = paths.slice(0, MAX_LISTED_PATHS).join(", ");
  return paths.length > MAX_LISTED_PATHS ? `${shown} and ${paths.length - MAX_LISTED_PATHS} more` : shown;
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** True for a path the run ignores: a policy-excluded glob or a heavy folder (node_modules, dist, ...). */
function isIgnored(file: string, excludedPaths: string[]): boolean {
  const norm = file.replace(/\\/g, "/");
  if (norm.split("/").some((part) => part !== ".git" && SNAPSHOT_SKIP_NAMES.includes(part))) return true;
  return excludedPaths.some((glob) => matchGlob(glob, norm));
}

/** Paths in `git status --porcelain -z` output (tracked and untracked), minus ignored ones. */
function changedPaths(porcelainZ: string, excludedPaths: string[]): string[] {
  const parts = porcelainZ.split("\0");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? "";
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    out.push(entry.slice(3));
    // A rename or copy is followed by its source path as its own entry.
    if (status.includes("R") || status.includes("C")) {
      const from = parts[i + 1];
      if (from) out.push(from);
      i += 1;
    }
  }
  return out.filter((p) => !isIgnored(p, excludedPaths));
}

/** Why the worktree no longer matches the run's last stage commit, or null when it does. */
async function worktreeProblem(
  runId: string,
  workspacePath: string,
  baseSha: string | null,
  excludedPaths: string[],
): Promise<string | null> {
  const cwd = workspacePath;
  let head: string;
  try {
    head = (await execGit(["rev-parse", "HEAD"], { cwd })).stdout.trim();
  } catch (error) {
    return `the run's worktree is not readable as a git checkout: ${error instanceof Error ? error.message : String(error)}`;
  }
  // The newest commit the runner made for this run: "agent(<short id>): <stage>".
  let expected = baseSha;
  try {
    const log = (
      await execGit(["log", "-n", "1", "--format=%H", "-F", `--grep=agent(${shortRunId(runId)}):`], { cwd })
    ).stdout.trim();
    if (log) expected = log;
  } catch {
    // fall back to the base commit
  }
  if (!expected) return "the run has no recorded base commit to compare the worktree with";
  if (head !== expected) {
    let paths: string[] = [];
    try {
      const diff = await execGit(["diff", "--name-only", "-z", expected, head], { cwd });
      paths = diff.stdout.split("\0").filter(Boolean).filter((p) => !isIgnored(p, excludedPaths));
    } catch {
      // the list is a courtesy
    }
    return (
      `the worktree has a commit that is not from this run (HEAD is ${head.slice(0, 8)}, the run's last commit is ${expected.slice(0, 8)})` +
      (paths.length > 0 ? `; changed: ${listPaths(paths)}` : "")
    );
  }
  let status: string;
  try {
    status = (await execGit(["status", "--porcelain", "-z", "--untracked-files=all"], { cwd })).stdout;
  } catch (error) {
    return `could not read the worktree status: ${error instanceof Error ? error.message : String(error)}`;
  }
  const dirty = changedPaths(status, excludedPaths);
  if (dirty.length > 0) return `the worktree has changes outside the run: ${listPaths(dirty)}`;
  return null;
}

/**
 * Whether the run can be resumed, and from where. Read-only apart from taking and
 * dropping the workspace lock to see whether someone else holds it.
 */
export async function checkResumable(db: AgentDatabase, runId: string, deps: ResumeDeps = {}): Promise<ResumeCheck> {
  const run = db.select().from(agentRuns).where(eq(agentRuns.id, runId)).get();
  if (!run) return { ok: false, reason: "The run does not exist" };
  if (!(RESUMABLE_STATUSES as readonly string[]).includes(run.status)) {
    return { ok: false, reason: `Only an interrupted, failed or stopped run can be resumed (this run is ${run.status})` };
  }
  if (!run.workspacePath || !fs.existsSync(run.workspacePath)) {
    return { ok: false, reason: "The run's worktree no longer exists, so it cannot be resumed" };
  }
  const open = db
    .select({ id: agentRunApprovals.id })
    .from(agentRunApprovals)
    .where(and(eq(agentRunApprovals.runId, runId), inArray(agentRunApprovals.status, OPEN_STATUSES)))
    .get();
  if (open) return { ok: false, reason: "An approval for this run is still open; decide it before resuming" };

  let request;
  try {
    request = runRequestSchema.parse(JSON.parse(run.request));
  } catch {
    return { ok: false, reason: "The run's request is not valid, so it cannot be resumed" };
  }
  let excludedPaths: string[];
  try {
    excludedPaths = toRunPolicy(getPolicy(db, run.projectId)).excludedPaths;
  } catch (error) {
    return { ok: false, reason: `The project policy is invalid: ${error instanceof Error ? error.message : String(error)}` };
  }

  // The repo lock: another run holding this working copy blocks a resume.
  const lock = acquireWorkspaceLock(db, runId, run.workspacePath, deps.pathDeps);
  if (!lock.ok) return { ok: false, reason: `The working copy is locked by run ${lock.heldBy}` };
  releaseWorkspaceLock(db, runId, lock.lockKey);

  // Stage boundaries and session ids come from the run's own event log.
  const events = db
    .select()
    .from(agentRunEvents)
    .where(
      and(
        eq(agentRunEvents.runId, runId),
        inArray(agentRunEvents.kind, ["stage_finished", "stage_started", "output"]),
      ),
    )
    .orderBy(asc(agentRunEvents.seq))
    .all();
  const finished = events.filter((e) => e.kind === "stage_finished");
  const last = finished[finished.length - 1];
  if (!last) return { ok: false, reason: "The run has no completed stage to resume from" };
  const lastStage = (last.stage ?? "") as RunStage;

  const workImplemented = finished.filter((e) => e.stage === "implement" || e.stage === "correct");
  const lastWork = workImplemented[workImplemented.length - 1];
  const workPayload = lastWork ? parsePayload(lastWork.payload) : {};
  const workOk = workPayload.exitCode === 0 && workPayload.error === undefined;
  const implementerExitCode = typeof workPayload.exitCode === "number" ? workPayload.exitCode : null;

  const hasPlanner = Boolean(request.roles.planner);
  let startAt: ResumeStartAt;
  if (lastStage === "inspect") startAt = hasPlanner ? "plan" : "implement";
  else if (lastStage === "plan") startAt = "implement";
  else if (lastStage === "implement") startAt = workOk ? "checks" : "implement";
  else startAt = "checks";

  // Correction rounds already completed; an unfinished one is redone from its checks.
  const round = startAt === "implement" || startAt === "plan" ? 0 : finished.filter((e) => e.stage === "correct").length;

  let plan: PlannerOutput | null = null;
  if (startAt !== "plan" && hasPlanner) {
    for (const e of events) {
      if (e.kind !== "output" || e.stage !== "plan") continue;
      const payload = parsePayload(e.payload);
      if (payload.kind !== "plan") continue;
      const parsed = plannerOutputSchema.safeParse(payload.plan);
      if (parsed.success) plan = parsed.data;
    }
    if (!plan) return { ok: false, reason: "The run's plan was not recorded, so it cannot be resumed past the plan stage" };
  }

  const consumedCommentIds: string[] = [];
  for (const e of events) {
    if (e.kind !== "stage_started" || e.stage !== "correct") continue;
    const ids = parsePayload(e.payload).commentIds;
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") consumedCommentIds.push(id);
  }

  let implementerSession: string | undefined;
  for (const e of events) {
    if (e.kind !== "output" || e.agent !== "implementer") continue;
    const sid = parsePayload(e.payload).sessionId;
    if (typeof sid === "string" && UUID_REGEX.test(sid)) implementerSession = sid;
  }

  const problem = await worktreeProblem(runId, run.workspacePath, run.baseRef, excludedPaths);
  if (problem) return { ok: false, reason: `Resume refused: ${problem}` };

  const sessionIds: ResumeSessionIds = implementerSession ? { implementer: implementerSession } : {};
  const context: ResumeContext = {
    fromStage: lastStage,
    startAt,
    workspace: {
      path: run.workspacePath,
      baseSha: run.baseRef ?? "",
      branch: run.branch ?? "",
      kind: (run.workspaceKind as WorkspaceKind | null) ?? "git_worktree",
    },
    ...(implementerSession ? { implementerSessionId: implementerSession } : {}),
    plan,
    round,
    consumedCommentIds,
    implementerExitCode,
  };
  return { ok: true, fromStage: lastStage, startAt, sessionIds, context };
}

export type RequestResumeResult = { ok: true; intentId: string } | { ok: false; reason: string };

/**
 * The API entry: checks, records the request and queues the `resume` intent. The
 * runner re-checks and executes it; nothing here touches the worktree.
 */
export async function requestResume(db: AgentDatabase, runId: string, deps: ResumeDeps = {}): Promise<RequestResumeResult> {
  const run = db.select().from(agentRuns).where(eq(agentRuns.id, runId)).get();
  const stage = (run?.stage ?? null) as RunStage | null;
  const refuse = async (reason: string): Promise<RequestResumeResult> => {
    if (run) {
      await appendEvent(db, { runId, stage, agent: "system", kind: "warning", payload: { message: `resume refused: ${reason}`, resume: true } });
    }
    return { ok: false, reason };
  };
  const pending = db
    .select({ id: agentRunIntents.id })
    .from(agentRunIntents)
    .where(and(eq(agentRunIntents.runId, runId), eq(agentRunIntents.kind, "resume"), isNull(agentRunIntents.claimedAt)))
    .get();
  if (pending) return { ok: false, reason: "A resume for this run is already queued" };
  const check = await checkResumable(db, runId, deps);
  if (!check.ok) return refuse(check.reason);
  await appendEvent(db, {
    runId,
    stage,
    agent: "system",
    kind: "warning",
    payload: { message: `resume requested from the ${check.fromStage} stage`, resume: true },
  });
  const intent = await createIntent(db, runId, "resume", {});
  return { ok: true, intentId: intent.id };
}

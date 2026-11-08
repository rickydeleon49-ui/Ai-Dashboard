/**
 * The AW.1 stage machine (design §7, §15 step 9): inspect → implement → checks
 * → diff → review → final.
 *
 * Two modes. A run with no planner and no reviewer role is the AW.1 flow: one
 * implement pass and one review through `deps.review`. A run that names a
 * planner or a reviewer role is the AW.2 flow: plan → implement → (checks →
 * diff → review → correct) with at most MAX_ROUNDS correction rounds, the
 * roles reached through `deps.roleRunners`.
 *
 * The rule that shapes everything here: **the agent's own claims never set the
 * status.** A run succeeds only on facts the runner observed itself — a
 * non-empty diff that touches no excluded path, every required check exiting
 * 0, and a schema-valid reviewer approval. Anything else fails, naming each
 * missing fact. Agent text such as "all tests pass" is recorded as an event
 * and otherwise ignored.
 *
 * Everything with a side effect (git, processes, the reviewer, checks) comes
 * in through `OrchestratorDeps`, so the decision logic is tested without
 * Claude, git or a real project.
 */
import fs from "node:fs";
import nodePath from "node:path";
import { eq, sql } from "drizzle-orm";
import { agentRuns } from "@/db/schema";
import type { AgentAdapter } from "./adapters/types";
import { listComments } from "./comments";
import { severityClass, type SeverityClass } from "./severity";
import { appendEvent, type AgentDatabase } from "./events";
import type { AgentExit, AgentProcessHandle, SpawnAgentOptions } from "./process";
import { acquireWorkspaceLock, releaseLocksForRun, type PathDeps } from "./roots";
import {
  buildCorrectionPrompt,
  buildPlannerPrompt,
  buildReviewerPrompt,
  MAX_ROUNDS,
  escapeBlock,
} from "./prompts";
import type { RoleRunner, RoleRunnerMap } from "./role-runners";
import {
  plannerOutputSchema,
  reviewerOutputSchema,
  runRequestSchema,
  type PlannerOutput,
  type ReviewerFinding,
  type ReviewerOutput,
  type RunRequest,
} from "./schema";
import type { EventAgent, EventKind, RunStage, RunStatus } from "./types";
import {
  isPathInScope,
  type CreateRunWorktreeResult,
  type DiffPatchResult,
  type DiffSummaryResult,
} from "./workspace";

/** A check from the project policy: a name the run request refers to, and the argv the runner executes. */
export interface PolicyCheck {
  name: string;
  argv: string[];
  timeoutSec?: number;
}

export interface RunPolicy {
  checks: PolicyCheck[];
  excludedPaths: string[];
}

export interface CheckResult {
  name: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Bounded, redacted when stored. */
  output: string;
}

export interface ReviewInput {
  task: string;
  diff: DiffSummaryResult;
  checks: CheckResult[];
  workspacePath: string;
  baseSha: string;
}

export interface OrchestratorDeps {
  db: AgentDatabase;
  implementer: AgentAdapter;
  /** Returns the reviewer's raw output; the orchestrator validates it. Used by runs without a reviewer role. */
  review: (input: ReviewInput, signal: AbortSignal) => Promise<unknown>;
  /**
   * Planner and reviewer transports by provider id (AW.2). A role whose provider
   * has no entry fails the run up front; there is no fallback.
   */
  roleRunners?: RoleRunnerMap;
  workspace: {
    create: (opts: { repoPath: string; worktreeRoot: string; runId: string }) => Promise<CreateRunWorktreeResult>;
    commit: (worktreePath: string, stage: string, runShortId: string) => Promise<string | null>;
    diff: (
      worktreePath: string,
      baseSha: string,
      opts: { excludedPaths: string[]; scopePaths?: string[] },
    ) => Promise<DiffSummaryResult>;
    /** Patch text for display only; a failure here never fails the run. */
    patch: (
      worktreePath: string,
      baseSha: string,
      opts: { excludedPaths: string[]; scopePaths?: string[] },
    ) => Promise<DiffPatchResult>;
    pathFor: (worktreeRoot: string, runId: string) => string;
    shortId: (runId: string) => string;
  };
  spawn: (options: SpawnAgentOptions) => AgentProcessHandle;
  stop: (handle: AgentProcessHandle, options?: { graceMs?: number }) => Promise<AgentExit>;
  runCheck: (check: PolicyCheck, cwd: string, signal: AbortSignal) => Promise<CheckResult>;
  storage: { worktreeRoot: string; runStore: string };
  /** Aborted when a stop intent arrives. */
  signal: AbortSignal;
  /** How long Stop waits before forcing (default: stopAgentProcess's 5 s). */
  stopGraceMs?: number;
  pathDeps?: PathDeps;
}

export interface RunOutcome {
  status: Extract<RunStatus, "succeeded" | "failed" | "stopped">;
  /** Every fact the decision was based on. */
  facts: {
    implementerExitCode: number | null;
    diffFiles: number;
    excludedTouched: string[];
    checks: Array<{ name: string; exitCode: number | null; timedOut: boolean }>;
    reviewVerdict: ReviewerOutput["verdict"] | null;
    /** AW.2 only: changed paths outside plan.scope_paths. */
    outOfScope?: string[];
  };
  /** AW.2 only: how many correction rounds ran (0..MAX_ROUNDS). */
  rounds?: { corrections: number };
  /** Why it did not succeed, one entry per missing fact. Empty on success. */
  missing: string[];
  error?: string;
}

class StoppedError extends Error {
  constructor() {
    super("stopped by user");
  }
}

const MAX_TEXT_EVENT_CHARS = 4000;

async function record(
  db: AgentDatabase,
  runId: string,
  stage: RunStage | null,
  agent: EventAgent,
  kind: EventKind,
  payload: unknown,
): Promise<void> {
  await appendEvent(db, { runId, stage, agent, kind, payload });
}

async function setStatus(
  db: AgentDatabase,
  runId: string,
  status: RunStatus,
  stage: RunStage | null,
  extra?: Record<string, unknown>,
): Promise<void> {
  db.update(agentRuns)
    .set({ status, stage, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
    .where(eq(agentRuns.id, runId))
    .run();
  await record(db, runId, stage, "system", "status_changed", { status, stage, ...extra });
}

function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new StoppedError();
}

/** The grant directory lives in the run store, never in the workspace (§6). */
export function grantDirFor(runStore: string, runId: string): string {
  return nodePath.join(runStore, "runs", runId);
}

export { severityClass, type SeverityClass };

/** A finding starts a correction round when it is actionable and blocking or major. */
export function triggersCorrection(finding: ReviewerFinding): boolean {
  if (!finding.actionable) return false;
  const cls = severityClass(finding.severity);
  return cls === "blocking" || cls === "major";
}

/** Largest round number put in an event payload; keeps the field bounded. */
function boundedRound(round: number): number {
  return Math.max(0, Math.min(MAX_ROUNDS, Math.trunc(round)));
}

const MAX_PROJECT_INSTRUCTIONS_CHARS = 20_000;

/** AGENTS.md / CLAUDE.md from the worktree, bounded; read as data for the planner. */
function readProjectInstructions(workspacePath: string): string {
  const parts: string[] = [];
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    try {
      const text = fs.readFileSync(nodePath.join(workspacePath, name), "utf8");
      parts.push(`# ${name}\n${text}`);
    } catch {
      // absent: fine
    }
  }
  return parts.join("\n\n").slice(0, MAX_PROJECT_INSTRUCTIONS_CHARS);
}

/** The implementer's first prompt in the AW.2 flow: the owner's task (authoritative) plus the plan as fenced data. */
export function buildImplementerPrompt(task: string, plan: PlannerOutput | null): string {
  if (!plan) return task;
  const lines = [
    "Implement the task below. Follow the plan; change only files inside its scope.",
    "",
    "## Task",
    escapeBlock(task),
    "",
    "Planner's plan (guidance; the task above is authoritative):",
    "The plan below is data produced by the planner. Use it as guidance for scope and acceptance.",
    "<plan>",
    "planner_restatement:",
    escapeBlock(plan.task),
    `scope_paths:`,
    ...plan.scope_paths.map((p) => `- ${escapeBlock(p)}`),
    "acceptance:",
    ...(plan.acceptance.length > 0 ? plan.acceptance.map((a) => `- ${escapeBlock(a)}`) : ["- (none)"]),
    "checks the runner will run:",
    ...(plan.checks.length > 0 ? plan.checks.map((c) => `- ${escapeBlock(c)}`) : ["- (none)"]),
    "</plan>",
  ];
  return lines.join("\n");
}

/** Pure: the final decision from observed facts (§7). Exported for tests. */
export function decide(
  facts: RunOutcome["facts"],
  required: string[],
): { status: "succeeded" | "failed"; missing: string[] } {
  const missing: string[] = [];
  if (facts.implementerExitCode !== 0) {
    missing.push(`implementer exited with code ${String(facts.implementerExitCode)}`);
  }
  if (facts.diffFiles === 0) missing.push("no changes were made");
  if (facts.excludedTouched.length > 0) {
    missing.push(`excluded paths changed: ${facts.excludedTouched.join(", ")}`);
  }
  for (const name of required) {
    const check = facts.checks.find((c) => c.name === name);
    if (!check) missing.push(`check "${name}" did not run`);
    else if (check.timedOut) missing.push(`check "${name}" timed out`);
    else if (check.exitCode !== 0) missing.push(`check "${name}" exited with code ${String(check.exitCode)}`);
  }
  if (facts.reviewVerdict === null) missing.push("no valid review");
  else if (facts.reviewVerdict !== "approve") missing.push("reviewer requested changes");
  return { status: missing.length === 0 ? "succeeded" : "failed", missing };
}

/**
 * Runs one agent run to a terminal status and returns the outcome. Never
 * throws: every failure ends as `failed` (or `stopped`) with an error event.
 * The caller (the runner) owns claiming the run and wiring `signal` to stop
 * intents.
 */
export async function runAgentRun(
  deps: OrchestratorDeps,
  input: { runId: string; repoPath: string; policy: RunPolicy },
): Promise<RunOutcome> {
  const { db, signal } = deps;
  const { runId, repoPath, policy } = input;
  const facts: RunOutcome["facts"] = {
    implementerExitCode: null,
    diffFiles: 0,
    excludedTouched: [],
    checks: [],
    reviewVerdict: null,
  };
  let required: string[] = [];
  let worktreePath: string | null = null;
  let shortId = "";
  let stage: RunStage = "inspect";
  const grantDir = grantDirFor(deps.storage.runStore, runId);
  /** AW.2 flow: planner/reviewer roles set. Round events carry `round` only then. */
  let roundsMode = false;
  /** Correction rounds started so far; the initial implement is round 0. */
  let round = 0;

  const record = (
    recStage: RunStage | null,
    agent: EventAgent,
    kind: EventKind,
    payload: unknown,
  ): Promise<void> => {
    const withRound =
      roundsMode && payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? { ...(payload as Record<string, unknown>), round: boundedRound(round) }
        : payload;
    return appendEvent(db, { runId, stage: recStage, agent, kind, payload: withRound }).then(() => undefined);
  };
  const roundExtra = (): Record<string, unknown> | undefined =>
    roundsMode ? { round: boundedRound(round) } : undefined;

  // §7: the grant is deleted and the lock released BEFORE the run turns
  // terminal, so whoever sees the terminal status can start the next run.
  let cleanedUp = false;
  const cleanUp = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      if (fs.existsSync(grantDir)) {
        // Delete only a real folder strictly inside <runStore>/runs: never follow a link out of it.
        const runsReal = fs.realpathSync.native(nodePath.join(deps.storage.runStore, "runs"));
        const rel = nodePath.relative(runsReal, fs.realpathSync.native(grantDir));
        if (rel !== "" && !rel.startsWith("..") && !nodePath.isAbsolute(rel)) {
          fs.rmSync(grantDir, { recursive: true, force: true });
        }
      }
    } catch {
      // Best effort: a leftover grant file is harmless once the run is terminal.
    }
    try {
      releaseLocksForRun(db, runId);
    } catch {
      // Never throw out of runAgentRun; a stale lock is reported by recovery.
    }
  };

  const finish = async (outcome: RunOutcome): Promise<RunOutcome> => {
    cleanUp();
    if (roundsMode) outcome = { ...outcome, rounds: { corrections: round } };
    db.update(agentRuns)
      .set({
        outcome: JSON.stringify(outcome),
        endedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      })
      .where(eq(agentRuns.id, runId))
      .run();
    await setStatus(db, runId, outcome.status, "final", roundExtra());
    return outcome;
  };

  /** A failed run with reasons stated by the orchestrator itself (AW.2). */
  const failWith = async (missing: string[], error?: string): Promise<RunOutcome> =>
    finish({ status: "failed", facts, missing, ...(error ? { error } : {}) });

  try {
    // inspect: validate the stored request against the policy before touching anything.
    const row = db.select().from(agentRuns).where(eq(agentRuns.id, runId)).get();
    if (!row) throw new Error(`run ${runId} not found`);
    const request: RunRequest = runRequestSchema.parse(JSON.parse(row.request));
    const unknownChecks = request.checks.filter((name) => !policy.checks.some((c) => c.name === name));
    if (unknownChecks.length > 0) {
      throw new Error(`checks not in the project policy: ${unknownChecks.join(", ")}`);
    }
    required = request.checks;
    const selected = policy.checks.filter((c) => required.includes(c.name));

    // AW.2: every named planner/reviewer role needs a runner before anything starts.
    roundsMode = Boolean(request.roles.planner || request.roles.reviewer);
    let plannerRunner: RoleRunner | null = null;
    let reviewerRunner: RoleRunner | null = null;
    if (roundsMode) {
      for (const role of ["planner", "reviewer"] as const) {
        const config = request.roles[role];
        if (!config) continue;
        const runner = deps.roleRunners?.[config.provider];
        if (!runner) {
          const message = `no runner is available for provider "${config.provider}" (${role} role)`;
          await record("inspect", "system", "error", { message });
          return await failWith([message], message);
        }
        if (role === "planner") plannerRunner = runner;
        else reviewerRunner = runner;
      }
    }

    await setStatus(db, runId, "preparing", "inspect", roundExtra());
    throwIfStopped(signal);

    // Workspace: lock the run's working copy, then create the worktree.
    worktreePath = deps.workspace.pathFor(deps.storage.worktreeRoot, runId);
    shortId = deps.workspace.shortId(runId);
    const lock = acquireWorkspaceLock(db, runId, worktreePath, deps.pathDeps);
    if (!lock.ok) throw new Error(`working copy is locked by run ${lock.heldBy}`);
    const ws = await deps.workspace.create({ repoPath, worktreeRoot: deps.storage.worktreeRoot, runId });
    worktreePath = ws.path;
    db.update(agentRuns)
      .set({ workspaceKind: "git_worktree", workspacePath: ws.path, baseRef: ws.baseSha, branch: ws.branch })
      .where(eq(agentRuns.id, runId))
      .run();
    await record("inspect", "system", "stage_finished", {
      stage: "inspect",
      workspacePath: ws.path,
      branch: ws.branch,
      baseSha: ws.baseSha,
    });

    // plan (AW.2): a validated plan feeds the implementer prompt and the scope check.
    let plan: PlannerOutput | null = null;
    const roleCall = (role: "planner" | "reviewer", prompt: string) => ({
      role,
      prompt,
      workspacePath: ws.path,
      model: request.roles[role]?.model,
      effort: request.roles[role]?.effort,
      grantDir,
      round,
    });
    if (plannerRunner) {
      stage = "plan";
      await setStatus(db, runId, "planning", stage, roundExtra());
      throwIfStopped(signal);
      await record(stage, "system", "stage_started", { stage });
      const planPrompt = buildPlannerPrompt({
        task: request.task,
        projectInstructions: readProjectInstructions(ws.path),
      });
      const res = await plannerRunner.runPlanner(roleCall("planner", planPrompt), signal);
      throwIfStopped(signal);
      if (!res.ok) {
        await record(stage, "planner", "error", { message: res.failure });
        return await failWith([`no valid plan: ${res.failure}`]);
      }
      const parsedPlan = plannerOutputSchema.safeParse(res.plan);
      if (!parsedPlan.success) {
        const issues = parsedPlan.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`);
        await record(stage, "planner", "error", { message: "planner output is not schema-valid", issues });
        return await failWith(["no valid plan: planner output is not schema-valid"]);
      }
      if (parsedPlan.data.scope_paths.length === 0) {
        await record(stage, "planner", "error", { message: "the plan has no scope_paths" });
        return await failWith(["no valid plan: the plan has no scope_paths"]);
      }
      plan = parsedPlan.data;
      await record(stage, "planner", "output", { kind: "plan", plan });
      await record(stage, "system", "stage_finished", { stage });
    }
    const scopePaths = plan?.scope_paths ?? [];

    // implement (round 0) and correct (rounds 1..MAX_ROUNDS) share one spawn path.
    let implementerSessionId: string | undefined;
    const runImplementer = async (
      implStage: "implement" | "correct",
      prompt: string,
      resumeSessionId: string | undefined,
    ): Promise<AgentExit> => {
      stage = implStage;
      await setStatus(db, runId, implStage === "implement" ? "implementing" : "correcting", stage, roundExtra());
      throwIfStopped(signal);
      if (roundsMode) await record(stage, "system", "stage_started", { stage });
      const invocation = deps.implementer.buildInvocation({
        workspacePath: ws.path,
        prompt,
        model: request.roles.implementer.model,
        effort: request.roles.implementer.effort,
        checkCommands: selected.map((c) => c.argv),
        excludedPaths: policy.excludedPaths,
        grantDir,
        ...(resumeSessionId ? { resumeSessionId } : {}),
      });
      const pending: Promise<void>[] = [];
      const handle = deps.spawn({
        file: invocation.file,
        args: invocation.args,
        cwd: invocation.cwd,
        // The adapter's allowlisted env replaces process.env entirely (§6 item 5).
        env: invocation.env as NodeJS.ProcessEnv,
        stdin: invocation.stdin,
        onJson: (value) => {
          for (const event of deps.implementer.parseLine(value)) {
            const sid = (event.payload as { sessionId?: unknown } | null)?.sessionId;
            if (typeof sid === "string" && sid) implementerSessionId = sid;
            pending.push(record(implStage, event.agent, event.kind, event.payload));
          }
        },
        onText: (stream, text) => {
          pending.push(
            record(implStage, "implementer", "output", {
              stream,
              text: text.slice(0, MAX_TEXT_EVENT_CHARS),
            }),
          );
        },
      });
      const onAbort = () => {
        deps.stop(handle, deps.stopGraceMs === undefined ? undefined : { graceMs: deps.stopGraceMs }).catch(() => {});
      };
      // An abort that already happened never fires its event: stop right away.
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      let exit: AgentExit;
      try {
        exit = await handle.done;
      } finally {
        signal.removeEventListener("abort", onAbort);
        // appendEvent inserts synchronously when called, so order is call order;
        // settle them all before any status change.
        await Promise.allSettled(pending);
      }
      if (signal.aborted || exit.stoppedByUs) throw new StoppedError();
      facts.implementerExitCode = exit.code;
      await record(implStage, "system", "stage_finished", {
        stage: implStage,
        exitCode: exit.code,
        signal: exit.signal,
        ...(exit.error ? { error: exit.error } : {}),
      });
      await deps.workspace.commit(ws.path, implStage, shortId);
      return exit;
    };

    // checks + diff: run by the runner itself (§7), never taken from the agent's summary.
    const checksAndDiff = async (): Promise<{ checkResults: CheckResult[]; diff: DiffSummaryResult }> => {
      stage = "checks";
      await setStatus(db, runId, "checking", stage, roundExtra());
      if (roundsMode) await record(stage, "system", "stage_started", { stage });
      facts.checks = [];
      const checkResults: CheckResult[] = [];
      for (const check of selected) {
        throwIfStopped(signal);
        const result = await deps.runCheck(check, ws.path, signal);
        throwIfStopped(signal);
        checkResults.push(result);
        facts.checks.push({ name: result.name, exitCode: result.exitCode, timedOut: result.timedOut });
        await record("checks", "checks", "check_result", {
          ...result,
          output: result.output.slice(-MAX_TEXT_EVENT_CHARS),
        });
      }

      stage = "diff";
      throwIfStopped(signal);
      db.update(agentRuns).set({ stage }).where(eq(agentRuns.id, runId)).run();
      const diffOpts = { excludedPaths: policy.excludedPaths, ...(scopePaths.length > 0 ? { scopePaths } : {}) };
      const diff = await deps.workspace.diff(ws.path, ws.baseSha, diffOpts);
      throwIfStopped(signal);
      facts.diffFiles = diff.files.length;
      facts.excludedTouched = diff.files.filter((f) => f.excluded).map((f) => f.path);
      if (roundsMode) {
        facts.outOfScope = diff.files.filter((f) => !isPathInScope(f.path, scopePaths)).map((f) => f.path);
      }
      await record("diff", "system", "diff_summary", diff);
      // Patch text is display-only: any failure is swallowed and diff_summary stays the source of truth.
      let patchResult: DiffPatchResult | null = null;
      try {
        patchResult = await deps.workspace.patch(ws.path, ws.baseSha, diffOpts);
      } catch {
        patchResult = null;
      }
      throwIfStopped(signal);
      if (patchResult) {
        try {
          await record("diff", "system", "diff_patch", patchResult);
        } catch {
          // not recorded: the run goes on
        }
      }
      return { checkResults, diff };
    };

    // ---- AW.1 flow: one implement pass, one review through deps.review. ----
    if (!roundsMode) {
      await runImplementer("implement", request.task, undefined);
      // An implementer that failed gets no checks or review: nothing it did can succeed.
      if (facts.implementerExitCode !== 0) {
        const decision = decide(facts, required);
        return await finish({ status: "failed", facts, missing: decision.missing });
      }
      const { checkResults, diff } = await checksAndDiff();

      // review: only when there is something to review.
      if (facts.diffFiles > 0) {
        stage = "review";
        await setStatus(db, runId, "reviewing", stage);
        throwIfStopped(signal);
        const raw = await deps.review(
          { task: request.task, diff, checks: checkResults, workspacePath: ws.path, baseSha: ws.baseSha },
          signal,
        );
        throwIfStopped(signal);
        const parsed = reviewerOutputSchema.safeParse(raw);
        if (parsed.success) {
          facts.reviewVerdict = parsed.data.verdict;
          await record("review", "reviewer", "review", parsed.data);
        } else {
          await record("review", "reviewer", "error", {
            message: "reviewer output is not schema-valid",
            issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`),
          });
        }
      }

      // A stop that arrived at any point up to here wins over the decision.
      throwIfStopped(signal);
      const decision = decide(facts, required);
      return await finish({ status: decision.status, facts, missing: decision.missing });
    }

    // ---- AW.2 flow: implement, then (checks, diff, review, decide, correct) until done. ----
    let prompt = buildImplementerPrompt(request.task, plan);
    let resumeId: string | undefined;
    for (;;) {
      await runImplementer(round === 0 ? "implement" : "correct", prompt, resumeId);
      if (facts.implementerExitCode !== 0) {
        const decision = decide(facts, required);
        return await failWith(decision.missing);
      }
      const { checkResults, diff } = await checksAndDiff();

      // Facts the runner observed decide first; the reviewer only sees a non-empty diff.
      if (facts.excludedTouched.length > 0 || facts.diffFiles === 0) {
        const missing: string[] = [];
        if (facts.diffFiles === 0) missing.push("no changes were made");
        if (facts.excludedTouched.length > 0) {
          missing.push(`excluded paths changed: ${facts.excludedTouched.join(", ")}`);
        }
        throwIfStopped(signal);
        return await failWith(missing);
      }

      stage = "review";
      await setStatus(db, runId, "reviewing", stage, roundExtra());
      throwIfStopped(signal);
      await record(stage, "system", "stage_started", { stage });
      // The owner's task is always THE task; the planner's restatement is guidance only.
      const reviewTask = request.task;
      let raw: unknown;
      if (reviewerRunner) {
        const res = await reviewerRunner.runReviewer(
          roleCall(
            "reviewer",
            buildReviewerPrompt({
              task: reviewTask,
              plan,
              baseSha: ws.baseSha,
              diffFiles: diff.files,
              checks: checkResults,
              round,
            }),
          ),
          signal,
        );
        throwIfStopped(signal);
        if (!res.ok) {
          await record(stage, "reviewer", "error", { message: res.failure });
          return await failWith([`no valid review: ${res.failure}`]);
        }
        raw = res.review;
      } else {
        raw = await deps.review(
          { task: reviewTask, diff, checks: checkResults, workspacePath: ws.path, baseSha: ws.baseSha },
          signal,
        );
      }
      throwIfStopped(signal);
      const parsed = reviewerOutputSchema.safeParse(raw);
      if (!parsed.success) {
        await record(stage, "reviewer", "error", {
          message: "reviewer output is not schema-valid",
          issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`),
        });
        return await failWith(["no valid review"]);
      }
      const review = parsed.data;
      facts.reviewVerdict = review.verdict;
      await record(stage, "reviewer", "review", review);
      await record(stage, "system", "stage_finished", { stage, verdict: review.verdict });

      // decide: what is still open after this round.
      const failedChecks: Array<CheckResult & { didNotRun?: boolean }> = checkResults.filter(
        (c) => required.includes(c.name) && (c.timedOut || c.exitCode !== 0),
      );
      for (const name of required) {
        if (!checkResults.some((c) => c.name === name)) {
          failedChecks.push({
            name,
            exitCode: null,
            timedOut: false,
            durationMs: 0,
            output: "the check did not run",
            didNotRun: true,
          });
        }
      }
      const triggers = review.findings.filter(triggersCorrection);
      const comments = await listComments(db, runId, round);
      const outOfScope = facts.outOfScope ?? [];
      // An out-of-scope change is fixable (revert it), so it starts a round too.
      const needsCorrection =
        triggers.length > 0 || failedChecks.length > 0 || comments.length > 0 || outOfScope.length > 0;

      if (needsCorrection && round < MAX_ROUNDS) {
        round += 1;
        resumeId = deps.implementer.supportsResume ? implementerSessionId : undefined;
        const findings: Array<{
          severity: string;
          path?: string;
          line?: number;
          message: string;
          actionable: boolean;
        }> = triggers.map((f) => ({
          severity: f.severity,
          path: f.path,
          line: f.line,
          message: f.message,
          actionable: true,
        }));
        for (const p of outOfScope) {
          findings.push({
            severity: "P2",
            path: p,
            message: "This path is outside the plan's scope. Revert it.",
            actionable: true,
          });
        }
        prompt = buildCorrectionPrompt({
          task: reviewTask,
          round,
          findings,
          failedChecks: failedChecks.map((c) => ({
            name: c.name,
            output: c.output,
            exitCode: c.exitCode,
            timedOut: c.timedOut,
          })),
          // The owner's comments stay in their own block, labelled as the user's.
          userComments: comments.map((c) => ({ file: c.file, line: c.line, body: c.body })),
        });
        await record("correct", "system", "stage_started", {
          stage: "correct",
          findings: findings.length,
          failedChecks: failedChecks.map((c) => c.name),
          userComments: comments.length,
          resumed: Boolean(resumeId),
        });
        continue;
      }

      // No further round: succeed only on every observed fact, else name what is missing.
      const missing: string[] = [];
      if (triggers.length > 0) {
        missing.push(`${triggers.length} open actionable finding(s) of blocking or major severity`);
      }
      for (const c of failedChecks) {
        missing.push(
          c.didNotRun
            ? `check "${c.name}" did not run`
            : c.timedOut
              ? `check "${c.name}" timed out`
              : `check "${c.name}" exited with code ${String(c.exitCode)}`,
        );
      }
      if (comments.length > 0) missing.push(`${comments.length} unaddressed user comment(s)`);
      if (review.verdict !== "approve") missing.push("reviewer requested changes");
      if (outOfScope.length > 0) missing.push(`changed paths outside the plan scope: ${outOfScope.join(", ")}`);
      if (needsCorrection) missing.unshift(`still not done after ${MAX_ROUNDS} correction rounds`);
      // A stop that arrived at any point up to here wins over the decision.
      throwIfStopped(signal);
      if (missing.length === 0) return await finish({ status: "succeeded", facts, missing: [] });
      return await failWith(missing);
    }
  } catch (error) {
    if (error instanceof StoppedError || signal.aborted) {
      // Keep whatever the agent wrote: commit it on the run branch before acknowledging the stop (§7).
      if (worktreePath && shortId) {
        try {
          await deps.workspace.commit(worktreePath, "stopped", shortId);
        } catch (commitError) {
          await record(stage, "system", "warning", {
            message: `could not commit work on stop: ${(commitError as Error).message}`,
          });
        }
      }
      await record(stage, "system", "warning", { message: "stopped by user" });
      return await finish({ status: "stopped", facts, missing: ["stopped by user"] });
    }
    const message = error instanceof Error ? error.message : String(error);
    await record(stage, "system", "error", { message });
    const decision = decide(facts, required);
    return await finish({ status: "failed", facts, missing: decision.missing, error: message });
  } finally {
    // Normally done by finish() before the terminal status; this covers a throw inside finish().
    cleanUp();
  }
}

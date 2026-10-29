/**
 * The AW.1 stage machine (design §7, §15 step 9): inspect → implement → checks
 * → diff → review → final, with a single review pass (correction rounds are
 * AW.2).
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
import { appendEvent, type AgentDatabase } from "./events";
import type { AgentExit, AgentProcessHandle, SpawnAgentOptions } from "./process";
import { acquireWorkspaceLock, releaseLocksForRun, type PathDeps } from "./roots";
import { reviewerOutputSchema, runRequestSchema, type ReviewerOutput, type RunRequest } from "./schema";
import type { EventAgent, EventKind, RunStage, RunStatus } from "./types";
import type { CreateRunWorktreeResult, DiffSummaryResult } from "./workspace";

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
  /** Returns the reviewer's raw output; the orchestrator validates it. */
  review: (input: ReviewInput, signal: AbortSignal) => Promise<unknown>;
  workspace: {
    create: (opts: { repoPath: string; worktreeRoot: string; runId: string }) => Promise<CreateRunWorktreeResult>;
    commit: (worktreePath: string, stage: string, runShortId: string) => Promise<string | null>;
    diff: (worktreePath: string, baseSha: string, opts: { excludedPaths: string[] }) => Promise<DiffSummaryResult>;
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
  };
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
): Promise<void> {
  db.update(agentRuns)
    .set({ status, stage, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
    .where(eq(agentRuns.id, runId))
    .run();
  await record(db, runId, stage, "system", "status_changed", { status, stage });
}

function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new StoppedError();
}

/** The grant directory lives in the run store, never in the workspace (§6). */
export function grantDirFor(runStore: string, runId: string): string {
  return nodePath.join(runStore, "runs", runId);
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
    db.update(agentRuns)
      .set({
        outcome: JSON.stringify(outcome),
        endedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      })
      .where(eq(agentRuns.id, runId))
      .run();
    await setStatus(db, runId, outcome.status, "final");
    return outcome;
  };

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

    await setStatus(db, runId, "preparing", "inspect");
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
    await record(db, runId, "inspect", "system", "stage_finished", {
      stage: "inspect",
      workspacePath: ws.path,
      branch: ws.branch,
      baseSha: ws.baseSha,
    });

    // implement
    stage = "implement";
    await setStatus(db, runId, "implementing", stage);
    throwIfStopped(signal);
    const invocation = deps.implementer.buildInvocation({
      workspacePath: ws.path,
      prompt: request.task,
      model: request.roles.implementer.model,
      effort: request.roles.implementer.effort,
      checkCommands: selected.map((c) => c.argv),
      excludedPaths: policy.excludedPaths,
      grantDir,
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
          pending.push(record(db, runId, "implement", event.agent, event.kind, event.payload));
        }
      },
      onText: (stream, text) => {
        pending.push(
          record(db, runId, "implement", "implementer", "output", {
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
    await record(db, runId, "implement", "system", "stage_finished", {
      stage: "implement",
      exitCode: exit.code,
      signal: exit.signal,
      ...(exit.error ? { error: exit.error } : {}),
    });
    await deps.workspace.commit(ws.path, "implement", shortId);

    // An implementer that failed gets no checks or review: nothing it did can succeed.
    if (facts.implementerExitCode !== 0) {
      const decision = decide(facts, required);
      return await finish({ status: "failed", facts, missing: decision.missing });
    }

    // checks: the runner runs them itself (§7), with shell: false.
    stage = "checks";
    await setStatus(db, runId, "checking", stage);
    const checkResults: CheckResult[] = [];
    for (const check of selected) {
      throwIfStopped(signal);
      const result = await deps.runCheck(check, ws.path, signal);
      throwIfStopped(signal);
      checkResults.push(result);
      facts.checks.push({ name: result.name, exitCode: result.exitCode, timedOut: result.timedOut });
      await record(db, runId, "checks", "checks", "check_result", {
        ...result,
        output: result.output.slice(-MAX_TEXT_EVENT_CHARS),
      });
    }

    // diff: computed by the runner from git, never from the agent's summary.
    stage = "diff";
    throwIfStopped(signal);
    db.update(agentRuns).set({ stage }).where(eq(agentRuns.id, runId)).run();
    const diff = await deps.workspace.diff(ws.path, ws.baseSha, { excludedPaths: policy.excludedPaths });
    throwIfStopped(signal);
    facts.diffFiles = diff.files.length;
    facts.excludedTouched = diff.files.filter((f) => f.excluded).map((f) => f.path);
    await record(db, runId, "diff", "system", "diff_summary", diff);

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
        await record(db, runId, "review", "reviewer", "review", parsed.data);
      } else {
        await record(db, runId, "review", "reviewer", "error", {
          message: "reviewer output is not schema-valid",
          issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`),
        });
      }
    }

    // A stop that arrived at any point up to here wins over the decision.
    throwIfStopped(signal);
    const decision = decide(facts, required);
    return await finish({ status: decision.status, facts, missing: decision.missing });
  } catch (error) {
    if (error instanceof StoppedError || signal.aborted) {
      // Keep whatever the agent wrote: commit it on the run branch before acknowledging the stop (§7).
      if (worktreePath && shortId) {
        try {
          await deps.workspace.commit(worktreePath, "stopped", shortId);
        } catch (commitError) {
          await record(db, runId, stage, "system", "warning", {
            message: `could not commit work on stop: ${(commitError as Error).message}`,
          });
        }
      }
      await record(db, runId, stage, "system", "warning", { message: "stopped by user" });
      return await finish({ status: "stopped", facts, missing: ["stopped by user"] });
    }
    const message = error instanceof Error ? error.message : String(error);
    await record(db, runId, stage, "system", "error", { message });
    const decision = decide(facts, required);
    return await finish({ status: "failed", facts, missing: decision.missing, error: message });
  } finally {
    // Normally done by finish() before the terminal status; this covers a throw inside finish().
    cleanUp();
  }
}

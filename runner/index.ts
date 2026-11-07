/**
 * The agent runner process (design §2.3, §7, §15 step 10).
 *
 * This is the only process that spawns agents. It polls `agent_run_intent`,
 * claims intents atomically, runs the orchestrator for `start` intents (one run
 * at a time in AW.1), aborts it for `stop`, and on startup repairs whatever a
 * previous runner left behind. Start it with `npm run runner`; the desktop shell
 * forks it beside the server (AW1-10).
 *
 * Everything with a side effect comes in through `createRunner` so tests drive
 * the pieces without a process.
 */
import fs from "node:fs";
import nodePath from "node:path";
import crypto from "node:crypto";
import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { agentProjectPolicies, agentRunEvents, agentRunIntents, agentRuns, projects } from "@/db/schema";
import type { AgentRunIntentRow } from "@/db/schema";
import type { AgentAdapter } from "@/core/agents/adapters/types";
import { claudeAdapter } from "@/core/agents/adapters/claude-code";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import { appendEvent, type AgentDatabase } from "@/core/agents/events";
import {
  grantDirFor,
  runAgentRun,
  type OrchestratorDeps,
  type PolicyCheck,
  type RunOutcome,
  type RunPolicy,
} from "@/core/agents/orchestrator";
import { spawnAgentProcess, stopAgentProcess } from "@/core/agents/process";
import { reviewWithClaude } from "@/core/agents/review-claude";
import { defaultRoleRunners } from "@/core/agents/role-runners";
import {
  checkRootAvailable,
  getAgentStorageSettings,
  releaseLocksForRun,
  resolveProjectPath,
  type AgentStorageSettings,
  type PathDeps,
} from "@/core/agents/roots";
import { runPolicyCheck } from "@/core/agents/run-check";
import { TERMINAL_STATUSES } from "@/core/agents/types";
import { commitStage, createRunWorktree, diffPatch, diffSummary, shortRunId, worktreePathFor } from "@/core/agents/workspace";

export const POLL_INTERVAL_MS = 500;
export const SHUTDOWN_WAIT_MS = 15_000;

const ISO_NOW = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export type LogFn = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;

/** NDJSON on stdout: one object per line, so the desktop shell can parse it. */
export const ndjsonLog: LogFn = (level, msg, extra) => {
  process.stdout.write(JSON.stringify({ level, msg, ...extra }) + "\n");
};

const policyChecksSchema = z.array(
  z
    .object({
      name: z.string().min(1),
      argv: z.array(z.string()).min(1),
      timeoutSec: z.number().positive().optional(),
    })
    .strict(),
);
const stringArraySchema = z.array(z.string());

/** appendEvent inserts synchronously; this only keeps a rejection from going unhandled. */
function fire(promise: Promise<unknown>): void {
  promise.catch(() => {});
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/**
 * Marks every run a previous runner left active as `interrupted` (§7 "Restart
 * recovery"). `queued` runs are untouched: nothing was started for them. Child
 * PIDs are not stored yet (a later round adds them), so nothing is killed here;
 * a leftover agent process from a crashed runner is not reaped by this step.
 * Returns the run ids it interrupted.
 */
export function recoverRuns(db: AgentDatabase, epoch: string, log: LogFn = ndjsonLog): string[] {
  const stale = db
    .select()
    .from(agentRuns)
    .where(notInArray(agentRuns.status, ["queued", ...TERMINAL_STATUSES]))
    .all()
    .filter((r) => r.runnerEpoch !== epoch);
  const ids: string[] = [];
  for (const run of stale) {
    db.update(agentRuns)
      .set({ status: "interrupted", endedAt: ISO_NOW, updatedAt: ISO_NOW })
      .where(eq(agentRuns.id, run.id))
      .run();
    releaseLocksForRun(db, run.id);
    const message = "the dashboard restarted while this run was active; it was not resumed";
    fire(appendEvent(db, { runId: run.id, stage: run.stage, agent: "system", kind: "warning", payload: { message } }));
    fire(
      appendEvent(db, {
        runId: run.id,
        stage: run.stage,
        agent: "system",
        kind: "status_changed",
        payload: { status: "interrupted", stage: run.stage },
      }),
    );
    ids.push(run.id);
    log("warn", "interrupted stale run", { runId: run.id, previousStatus: run.status });
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Worktree recovery report (§10A idea 3): report only, deletes nothing
// ---------------------------------------------------------------------------

export interface WorktreeReport {
  /** Runs whose recorded workspace folder no longer exists. */
  recordedButMissing: Array<{ runId: string; path: string }>;
  /** Folders under <worktreeRoot>/command-center/ that no run records. */
  presentButUnknown: string[];
}

const MISSING_FOLDER_MARKER = "its workspace folder is missing";

function normPath(p: string): string {
  const resolved = nodePath.resolve(p);
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

export function worktreeReport(db: AgentDatabase, worktreeRoot: string, log: LogFn = ndjsonLog): WorktreeReport {
  const report: WorktreeReport = { recordedButMissing: [], presentButUnknown: [] };
  const runs = db.select().from(agentRuns).all();
  const recorded = new Map<string, string>();
  for (const run of runs) {
    if (!run.workspacePath) continue;
    recorded.set(normPath(run.workspacePath), run.id);
    if (!fs.existsSync(run.workspacePath)) {
      report.recordedButMissing.push({ runId: run.id, path: run.workspacePath });
      const already = db
        .select()
        .from(agentRunEvents)
        .where(and(eq(agentRunEvents.runId, run.id), eq(agentRunEvents.kind, "warning")))
        .all()
        .some((e) => e.payload.includes(MISSING_FOLDER_MARKER));
      if (!already) {
        fire(
          appendEvent(db, {
            runId: run.id,
            stage: run.stage,
            agent: "system",
            kind: "warning",
            payload: { message: `${MISSING_FOLDER_MARKER}: ${run.workspacePath}` },
          }),
        );
      }
      log("warn", "worktree recorded but missing", { runId: run.id, path: run.workspacePath });
    }
  }
  const commandCenter = nodePath.join(worktreeRoot, "command-center");
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(commandCenter, { withFileTypes: true });
  } catch {
    // No folder yet: nothing is present.
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = nodePath.join(commandCenter, entry.name);
    if (!recorded.has(normPath(full))) {
      report.presentButUnknown.push(full);
      log("warn", "worktree present but not recorded by any run", { path: full });
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

/**
 * Atomically claims the oldest unclaimed intent. Two claimers can never get the
 * same intent: the UPDATE only matches while `claimed_at IS NULL`.
 */
export function claimNextIntent(
  db: AgentDatabase,
  options: { excludeKinds?: string[]; excludeIds?: string[] } = {},
): AgentRunIntentRow | null {
  const exclude = options.excludeKinds ?? [];
  const excludeIds = options.excludeIds ?? [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = db
      .select()
      .from(agentRunIntents)
      .where(
        and(
          isNull(agentRunIntents.claimedAt),
          exclude.length > 0 ? notInArray(agentRunIntents.kind, exclude) : undefined,
          excludeIds.length > 0 ? notInArray(agentRunIntents.id, excludeIds) : undefined,
        ),
      )
      .orderBy(asc(agentRunIntents.createdAt), asc(sql`rowid`))
      .limit(1)
      .get();
    if (!candidate) return null;
    const result = db
      .update(agentRunIntents)
      .set({ claimedAt: ISO_NOW })
      .where(and(eq(agentRunIntents.id, candidate.id), isNull(agentRunIntents.claimedAt)))
      .run();
    if ((result as { changes: number }).changes === 1) return candidate;
    // Someone else won this one; try the next.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Single-runner lock
// ---------------------------------------------------------------------------

export type RunnerLockResult =
  | { ok: true; lockPath: string; release: () => void }
  | { ok: false; holderPid: number | null };

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Exclusive <runStore>/runner.lock holding {pid, epoch, startedAt}. A lock
 * whose pid is dead is replaced; a live holder means this runner must not start
 * (and must not run recovery, which would interrupt the holder's runs).
 */
export function acquireRunnerLock(
  runStore: string,
  epoch: string,
  deps: { isAlive?: (pid: number) => boolean; pid?: number } = {},
): RunnerLockResult {
  const isAlive = deps.isAlive ?? isPidAlive;
  const lockPath = nodePath.join(runStore, "runner.lock");
  fs.mkdirSync(runStore, { recursive: true });
  const body = JSON.stringify({ pid: deps.pid ?? process.pid, epoch, startedAt: new Date().toISOString() });
  const release = () => {
    try {
      const held = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { epoch?: unknown };
      if (held.epoch === epoch) fs.rmSync(lockPath, { force: true });
    } catch {
      // Already gone or replaced: not ours to remove.
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, body);
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, lockPath, release };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let holderPid: number | null = null;
    try {
      const held = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown };
      if (typeof held.pid === "number") holderPid = held.pid;
    } catch {
      // Unreadable or half-written: treated as stale below.
    }
    if (holderPid !== null && isAlive(holderPid)) return { ok: false, holderPid };
    fs.rmSync(lockPath, { force: true });
  }
  return { ok: false, holderPid: null };
}

export interface RunnerOverrides {
  db: AgentDatabase;
  epoch?: string;
  log?: LogFn;
  implementer?: AgentAdapter;
  getStorage?: () => Promise<AgentStorageSettings>;
  pathDeps?: PathDeps;
  /** Replaces individual orchestrator dependencies (tests). */
  orchestrator?: Partial<Omit<OrchestratorDeps, "db" | "signal" | "storage">>;
  /** Directory-availability check for the project's workspace root. */
  isDirectory?: (p: string) => boolean;
  pollIntervalMs?: number;
  stopGraceMs?: number;
  /** Clock for the stop-intent re-release backoff (tests). */
  now?: () => number;
}

/** A stop intent released because its run is not ours is not re-claimed for this long. */
export const RELEASED_INTENT_BACKOFF_MS = 5000;

interface ActiveRun {
  runId: string;
  controller: AbortController;
  done: Promise<void>;
}

export interface Runner {
  readonly epoch: string;
  readonly activeRunId: () => string | null;
  recover(): string[];
  report(): Promise<WorktreeReport>;
  claimNext(): AgentRunIntentRow | null;
  handleIntent(intent: AgentRunIntentRow): Promise<void>;
  /** Claims and handles at most one intent. Returns true when it handled one. */
  tick(): Promise<boolean>;
  /** Resolves when no run is active. */
  idle(): Promise<void>;
  start(): Promise<void>;
  shutdown(waitMs?: number): Promise<void>;
}

export function createRunner(overrides: RunnerOverrides): Runner {
  const { db } = overrides;
  const epoch = overrides.epoch ?? crypto.randomBytes(8).toString("hex");
  const log = overrides.log ?? ndjsonLog;
  const getStorage = overrides.getStorage ?? (() => getAgentStorageSettings());
  let active: ActiveRun | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopping = false;
  let ticking = false;
  const now = overrides.now ?? Date.now;
  const releasedAt = new Map<string, number>();

  const event = (runId: string, stage: string | null, kind: "warning" | "error" | "status_changed", payload: unknown) =>
    appendEvent(db, { runId, stage, agent: "system", kind, payload });

  /** Fails a run before the orchestrator ever started it. */
  async function failRun(runId: string, reason: string): Promise<void> {
    const outcome: RunOutcome = {
      status: "failed",
      facts: { implementerExitCode: null, diffFiles: 0, excludedTouched: [], checks: [], reviewVerdict: null },
      missing: [reason],
      error: reason,
    };
    await event(runId, "inspect", "error", { message: reason });
    releaseLocksForRun(db, runId);
    db.update(agentRuns)
      .set({ status: "failed", stage: "final", outcome: JSON.stringify(outcome), endedAt: ISO_NOW, updatedAt: ISO_NOW })
      .where(eq(agentRuns.id, runId))
      .run();
    await event(runId, "final", "status_changed", { status: "failed", stage: "final" });
    log("warn", "run failed before start", { runId, reason });
  }

  async function launch(runId: string, controller: AbortController): Promise<void> {
    const row = db.select().from(agentRuns).where(eq(agentRuns.id, runId)).get();
    if (!row) {
      log("warn", "start intent for a missing run", { runId });
      return;
    }
    if (row.status !== "queued") {
      log("warn", "start intent for a run that is not queued; ignoring", { runId, status: row.status });
      return;
    }
    // Claim the run for this runner first, so recovery elsewhere never confuses it for stale.
    db.update(agentRuns).set({ runnerEpoch: epoch, updatedAt: ISO_NOW }).where(eq(agentRuns.id, runId)).run();

    const project = db.select().from(projects).where(eq(projects.id, row.projectId)).get();
    if (!project) return failRun(runId, "project not found");
    if (!project.localPath) return failRun(runId, "project has no local path");

    const storage = await getStorage();
    const resolved = resolveProjectPath(project.localPath, storage.workspaceRoots, overrides.pathDeps);
    if (!resolved.ok) return failRun(runId, `project path refused: ${resolved.reason}`);
    const available = checkRootAvailable(resolved.root, { isDirectory: overrides.isDirectory });
    if (!available.ok) return failRun(runId, `project path refused: ${available.reason}`);

    let policy: RunPolicy;
    try {
      const policyRow = db
        .select()
        .from(agentProjectPolicies)
        .where(eq(agentProjectPolicies.projectId, row.projectId))
        .get();
      const checks: PolicyCheck[] = policyRow ? policyChecksSchema.parse(JSON.parse(policyRow.checkCommands)) : [];
      const excludedPaths = policyRow ? stringArraySchema.parse(JSON.parse(policyRow.excludedPaths)) : [];
      policy = { checks, excludedPaths };
    } catch (error) {
      return failRun(runId, `project policy is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }

    const stopGraceMs = overrides.stopGraceMs;
    const deps: OrchestratorDeps = {
      db,
      implementer: overrides.implementer ?? claudeAdapter,
      review: (input, signal) =>
        reviewWithClaude(input, signal, { grantDir: nodePath.join(grantDirFor(storage.runStore, runId), "review") }),
      workspace: {
        create: createRunWorktree,
        commit: commitStage,
        diff: diffSummary,
        patch: diffPatch,
        pathFor: worktreePathFor,
        shortId: shortRunId,
      },
      spawn: spawnAgentProcess,
      stop: stopAgentProcess,
      runCheck: (check, cwd, signal) => runPolicyCheck(check, cwd, signal),
      storage: { worktreeRoot: storage.worktreeRoot, runStore: storage.runStore },
      signal: controller.signal,
      stopGraceMs,
      pathDeps: overrides.pathDeps,
      // AW.2 planner/reviewer roles (Claude Code, Codex); a role whose provider has no runner fails the run up front.
      roleRunners: defaultRoleRunners(),
      ...overrides.orchestrator,
    };
    // The grant folder's parent must exist for the orchestrator's safe cleanup.
    fs.mkdirSync(nodePath.join(storage.runStore, "runs"), { recursive: true });
    log("info", "starting run", { runId });
    const outcome = await runAgentRun(deps, { runId, repoPath: resolved.realPath, policy });
    log("info", "run finished", { runId, status: outcome.status });
  }

  async function handleIntent(intent: AgentRunIntentRow): Promise<void> {
    if (intent.kind === "start") {
      if (active) {
        // One run at a time in AW.1: put it back so a later tick takes it.
        db.update(agentRunIntents).set({ claimedAt: null }).where(eq(agentRunIntents.id, intent.id)).run();
        return;
      }
      const controller = new AbortController();
      const runId = intent.runId;
      const entry: ActiveRun = {
        runId,
        controller,
        done: Promise.resolve(),
      };
      active = entry;
      entry.done = launch(runId, controller)
        .catch(async (error) => {
          const message = error instanceof Error ? error.message : String(error);
          log("error", "run crashed in the runner", { runId, error: message });
          const row = db.select().from(agentRuns).where(eq(agentRuns.id, runId)).get();
          if (row && !(TERMINAL_STATUSES as readonly string[]).includes(row.status)) {
            await failRun(runId, `runner error: ${message}`);
          }
        })
        .finally(() => {
          if (active === entry) active = null;
        });
      return;
    }

    if (intent.kind === "stop") {
      if (active && active.runId === intent.runId) {
        log("info", "stopping run", { runId: intent.runId });
        active.controller.abort();
        return;
      }
      const row = db.select().from(agentRuns).where(eq(agentRuns.id, intent.runId)).get();
      if (!row) {
        log("warn", "stop intent for a missing run", { runId: intent.runId });
        return;
      }
      if (row.status === "queued") {
        const result = db
          .update(agentRuns)
          .set({ status: "stopped", stage: "final", endedAt: ISO_NOW, updatedAt: ISO_NOW })
          .where(and(eq(agentRuns.id, intent.runId), eq(agentRuns.status, "queued")))
          .run();
        if ((result as { changes: number }).changes === 1) {
          releaseLocksForRun(db, intent.runId);
          await event(intent.runId, null, "warning", { message: "stopped by user before it started" });
          await event(intent.runId, "final", "status_changed", { status: "stopped", stage: "final" });
          log("info", "stopped a queued run", { runId: intent.runId });
        }
        return;
      }
      if (!(TERMINAL_STATUSES as readonly string[]).includes(row.status)) {
        // Another runner may host it: put the intent back so it is not lost.
        db.update(agentRunIntents).set({ claimedAt: null }).where(eq(agentRunIntents.id, intent.id)).run();
        releasedAt.set(intent.id, now());
        log("warn", "stop intent released: run is not active in this runner", { runId: intent.runId, status: row.status });
        return;
      }
      log("info", "stop intent ignored: run is already finished", { runId: intent.runId, status: row.status });
      return;
    }

    log("info", "intent kind not used in AW.1; marked claimed", { intentId: intent.id, kind: intent.kind });
  }

  async function tick(): Promise<boolean> {
    const t = now();
    for (const [id, at] of releasedAt) if (t - at >= RELEASED_INTENT_BACKOFF_MS) releasedAt.delete(id);
    const intent = claimNextIntent(db, {
      excludeKinds: active ? ["start"] : [],
      excludeIds: [...releasedAt.keys()],
    });
    if (!intent) return false;
    await handleIntent(intent);
    return true;
  }

  async function loop(): Promise<void> {
    if (stopping || ticking) return;
    ticking = true;
    try {
      while (!stopping && (await tick())) {
        // Drain whatever is ready.
      }
    } catch (error) {
      log("error", "runner loop error", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      ticking = false;
    }
    if (!stopping) timer = setTimeout(() => void loop(), overrides.pollIntervalMs ?? POLL_INTERVAL_MS);
  }

  return {
    epoch,
    activeRunId: () => active?.runId ?? null,
    recover: () => recoverRuns(db, epoch, log),
    report: async () => worktreeReport(db, (await getStorage()).worktreeRoot, log),
    claimNext: () => claimNextIntent(db),
    handleIntent,
    tick,
    idle: async () => {
      while (active) await active.done;
    },
    async start() {
      log("info", "runner starting", { epoch });
      recoverRuns(db, epoch, log);
      try {
        worktreeReport(db, (await getStorage()).worktreeRoot, log);
      } catch (error) {
        log("warn", "worktree report failed", { error: error instanceof Error ? error.message : String(error) });
      }
      void loop();
    },
    async shutdown(waitMs = SHUTDOWN_WAIT_MS) {
      stopping = true;
      if (timer) clearTimeout(timer);
      const current = active;
      if (current) {
        log("info", "shutting down: stopping the active run", { runId: current.runId });
        current.controller.abort();
        let finished = false;
        let timer2: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          current.done.then(() => {
            finished = true;
          }),
          new Promise<void>((resolve) => {
            // Deliberately ref'd: shutdown awaits this, and an unref'd timer lets the
            // event loop empty (stranding the promise) when nothing else is live.
            timer2 = setTimeout(resolve, waitMs);
          }),
        ]);
        if (timer2) clearTimeout(timer2);
        if (!finished) {
          const row = db.select().from(agentRuns).where(eq(agentRuns.id, current.runId)).get();
          if (row && !(TERMINAL_STATUSES as readonly string[]).includes(row.status)) {
            db.update(agentRuns)
              .set({ status: "interrupted", endedAt: ISO_NOW, updatedAt: ISO_NOW })
              .where(eq(agentRuns.id, current.runId))
              .run();
            releaseLocksForRun(db, current.runId);
            fire(
              appendEvent(db, {
                runId: current.runId,
                stage: row.stage,
                agent: "system",
                kind: "warning",
                payload: { message: "the runner shut down before the run could stop; it was interrupted" },
              }),
            );
            fire(
              appendEvent(db, {
                runId: current.runId,
                stage: row.stage,
                agent: "system",
                kind: "status_changed",
                payload: { status: "interrupted", stage: row.stage },
              }),
            );
            log("warn", "run did not stop in time; marked interrupted", { runId: current.runId });
          }
        }
      }
      log("info", "runner stopped");
    },
  };
}

// ---------------------------------------------------------------------------
// Process entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!isAgentRunsEnabled()) {
    ndjsonLog("error", "agent runs are not enabled in this environment; the runner will not start");
    process.exit(1);
  }
  const { db } = await import("@/db/client");
  // The server owns migrations and runs them as it starts. On a fresh install the
  // runner can get here first, so wait for the tables rather than migrating too
  // (two processes migrating at once could apply the same migration twice).
  let storage: Awaited<ReturnType<typeof getAgentStorageSettings>> | undefined;
  for (let attempt = 0; storage === undefined; attempt++) {
    try {
      storage = await getAgentStorageSettings();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/no such table/i.test(message) || attempt >= 120) throw error;
      if (attempt === 0) ndjsonLog("info", "waiting for the database to be migrated", { error: message });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const runner = createRunner({ db });
  // Recovery assumes every other-epoch run is dead, so only the lock holder may run it.
  const lock = acquireRunnerLock(storage.runStore, runner.epoch);
  if (!lock.ok) {
    ndjsonLog("info", "another runner is already running; exiting", { holderPid: lock.holderPid });
    process.exit(0);
  }
  let shuttingDown = false;
  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    ndjsonLog("info", "shutdown requested", { reason });
    void runner.shutdown().then(() => {
      lock.release();
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  // Forked by the desktop app: if it dies, the IPC channel closes. Don't outlive
  // it as an orphan that holds the runner lock and keeps agents running.
  if (process.send) process.on("disconnect", () => shutdown("parent exited"));
  process.on("message", (message) => {
    if (message && typeof message === "object" && (message as { type?: unknown }).type === "shutdown") {
      shutdown("ipc");
    }
  });
  await runner.start();
}

if (process.argv[1] && /(?:runner[\\/]index\.ts|runner\.js)$/.test(process.argv[1])) {
  main().catch((error) => {
    ndjsonLog("error", "runner failed to start", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
}

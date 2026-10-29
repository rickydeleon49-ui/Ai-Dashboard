/**
 * Unit tests for the agent-run orchestrator (Release AW.1, AW1-08).
 *
 * The implementer is a real child process (the credential-free fake agent);
 * git, checks and the reviewer are stubs the test controls. Covers the rule
 * that agent claims never count: only observed facts decide the status.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db";
import { agentRuns, agentWorkspaceLocks, projects } from "../../src/db/schema";
import { readSince, type StoredAgentEvent } from "../../src/core/agents/events";
import { fakeAdapter } from "../../src/core/agents/adapters/fake";
import { spawnAgentProcess, stopAgentProcess, type AgentProcessHandle } from "../../src/core/agents/process";
import { acquireWorkspaceLock } from "../../src/core/agents/roots";
import {
  decide,
  grantDirFor,
  runAgentRun,
  type CheckResult,
  type OrchestratorDeps,
  type PolicyCheck,
  type RunOutcome,
  type RunPolicy,
} from "../../src/core/agents/orchestrator";
import type { DiffSummaryFile, DiffSummaryResult } from "../../src/core/agents/workspace";

let db: typeof import("../../src/db/client").db;
const tempDirs: string[] = [];
let counter = 0;

before(async () => {
  await migrate();
  ({ db } = await import("../../src/db/client"));
  db.insert(projects).values({ id: "prj-orch", name: "Orchestrator" }).run();
});

after(async () => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  await cleanup();
});

const POLICY: RunPolicy = {
  checks: [
    { name: "lint", argv: ["npm", "run", "lint"] },
    { name: "test", argv: ["npm", "test"] },
  ],
  excludedPaths: ["secrets/**"],
};

function file(p: string, excluded = false): DiffSummaryFile {
  return { path: p, status: "added", additions: 1, deletions: 0, binary: false, outOfScope: false, excluded };
}
function diffOf(...files: DiffSummaryFile[]): DiffSummaryResult {
  return { files, totals: { files: files.length, additions: files.length, deletions: 0 } };
}
const ok = (name: string): CheckResult => ({ name, exitCode: 0, timedOut: false, durationMs: 1, output: "ok" });

interface Env {
  runId: string;
  root: string;
  runStore: string;
  worktreeRoot: string;
  deps: OrchestratorDeps;
  controller: AbortController;
  calls: {
    create: number;
    commit: string[];
    review: number;
    runCheck: string[];
    handles: AgentProcessHandle[];
  };
}

interface Opts {
  scenario?: string;
  checks?: string[];
  checkResults?: Record<string, Partial<CheckResult>>;
  diff?: DiffSummaryResult;
  review?: unknown;
  /** Runs inside the stubs, before they return. */
  onReview?: (env: Env) => void;
  onDiff?: (env: Env) => void;
  onSpawn?: (env: Env, handle: AgentProcessHandle) => void;
  stopGraceMs?: number;
  /** Records the lock count each time the orchestrator issues a db.update. */
  lockSnapshots?: number[];
  /** Aborts on the first db transaction after the review stub ran (i.e. while the review event is stored). */
  abortOnDbAfterReview?: boolean;
}

function makeEnv(opts: Opts = {}): Env {
  const runId = `run-orch-${++counter}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orch test "));
  tempDirs.push(root);
  const runStore = path.join(root, "run store");
  const worktreeRoot = path.join(root, "work trees");
  fs.mkdirSync(path.join(runStore, "runs"), { recursive: true });
  fs.mkdirSync(worktreeRoot, { recursive: true });
  const request = {
    projectId: "prj-orch",
    task: "do the thing",
    roles: { implementer: { provider: "fake", model: opts.scenario ?? "success" } },
    checks: opts.checks ?? ["lint", "test"],
  };
  db.insert(agentRuns).values({ id: runId, projectId: "prj-orch", request: JSON.stringify(request) }).run();

  const calls: Env["calls"] = { create: 0, commit: [], review: 0, runCheck: [], handles: [] };
  const controller = new AbortController();
  const wtPath = (r: string) => path.join(worktreeRoot, r);
  let envRef: Env | undefined;
  const dbForDeps = opts.lockSnapshots || opts.abortOnDbAfterReview
    ? (new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "transaction" && opts.abortOnDbAfterReview && calls.review > 0) {
            // The orchestrator persists the review event right after its post-review stop check.
            envRef!.controller.abort();
          }
          if (prop === "update" && !opts.lockSnapshots) return Reflect.get(target, prop, receiver).bind(target);
          if (prop === "update") {
            return (...a: unknown[]) => {
              opts.lockSnapshots!.push(
                target.select().from(agentWorkspaceLocks).where(eq(agentWorkspaceLocks.runId, runId)).all().length,
              );
              return (target.update as (...x: unknown[]) => unknown).apply(target, a);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as typeof db)
    : db;
  const deps: OrchestratorDeps = {
    db: dbForDeps,
    stopGraceMs: opts.stopGraceMs,
    implementer: fakeAdapter,
    review: async () => {
      calls.review++;
      opts.onReview?.(envRef!);
      return opts.review ?? { verdict: "approve", findings: [] };
    },
    workspace: {
      create: async ({ runId: r }) => {
        calls.create++;
        fs.mkdirSync(wtPath(r), { recursive: true });
        return { path: wtPath(r), branch: `agent/${r}`, baseSha: "a".repeat(40) };
      },
      commit: async (_p, stage) => {
        calls.commit.push(stage);
        return "b".repeat(40);
      },
      diff: async () => {
        opts.onDiff?.(envRef!);
        return opts.diff ?? diffOf(file("fake-output.txt"));
      },
      pathFor: (_root, r) => wtPath(r),
      shortId: (r) => r.slice(-6),
    },
    spawn: (o) => {
      const h = spawnAgentProcess(o);
      calls.handles.push(h);
      opts.onSpawn?.(envRef!, h);
      return h;
    },
    stop: (h, o) => stopAgentProcess(h, o),
    runCheck: async (check: PolicyCheck) => {
      calls.runCheck.push(check.name);
      return { ...ok(check.name), ...(opts.checkResults?.[check.name] ?? {}) };
    },
    storage: { worktreeRoot, runStore },
    signal: controller.signal,
  };
  envRef = { runId, root, runStore, worktreeRoot, deps, controller, calls };
  return envRef;
}

const run = (env: Env): Promise<RunOutcome> =>
  runAgentRun(env.deps, { runId: env.runId, repoPath: path.join(env.root, "repo"), policy: POLICY });

async function events(env: Env): Promise<StoredAgentEvent[]> {
  return readSince(db, env.runId, 0, 1000);
}
const statuses = (evs: StoredAgentEvent[]): string[] =>
  evs
    .filter((e) => e.kind === "status_changed")
    .map((e) => (e.payload as { status?: string }).status)
    .filter((s): s is string => typeof s === "string");

function rowOf(env: Env) {
  const row = db.select().from(agentRuns).where(eq(agentRuns.id, env.runId)).get();
  assert.ok(row);
  return row;
}
function assertTerminal(env: Env, outcome: RunOutcome): void {
  const row = rowOf(env);
  assert.equal(row.status, outcome.status);
  assert.ok(row.endedAt, "ended_at is set");
  assert.deepEqual(JSON.parse(row.outcome as string), JSON.parse(JSON.stringify(outcome)));
}
function assertCleanedUp(env: Env): void {
  const locks = db.select().from(agentWorkspaceLocks).where(eq(agentWorkspaceLocks.runId, env.runId)).all();
  assert.equal(locks.length, 0, "workspace lock released");
  assert.equal(fs.existsSync(grantDirFor(env.runStore, env.runId)), false, "grant dir removed");
}
function assertWorkspaceRecorded(env: Env): void {
  const row = rowOf(env);
  assert.equal(row.workspacePath, path.join(env.worktreeRoot, env.runId));
  assert.equal(row.branch, `agent/${env.runId}`);
  assert.equal(row.baseRef, "a".repeat(40));
}

describe("runAgentRun (AW1-08)", () => {
  it("1. happy path succeeds on observed facts", { timeout: 30_000 }, async () => {
    const env = makeEnv();
    // Pre-create the grant dir with a file: it must be gone afterwards.
    fs.mkdirSync(grantDirFor(env.runStore, env.runId), { recursive: true });
    fs.writeFileSync(path.join(grantDirFor(env.runStore, env.runId), "claude-settings.json"), "{}");
    const outcome = await run(env);
    assert.equal(outcome.status, "succeeded");
    assert.deepEqual(outcome.missing, []);
    assert.equal(outcome.facts.reviewVerdict, "approve");
    assert.equal(outcome.facts.implementerExitCode, 0);
    assertTerminal(env, outcome);
    assertWorkspaceRecorded(env);
    const evs = await events(env);
    assert.deepEqual(statuses(evs), ["preparing", "implementing", "checking", "reviewing", "succeeded"]);
    assert.ok(evs.some((e) => e.agent === "implementer" && e.kind === "output"), "output event");
    assert.ok(evs.some((e) => e.kind === "tool_call"), "tool_call event");
    assert.equal(evs.filter((e) => e.kind === "check_result").length, 2);
    assert.ok(evs.some((e) => e.kind === "diff_summary"));
    assert.ok(evs.some((e) => e.kind === "review" && e.agent === "reviewer"));
    assert.ok(env.calls.commit.includes("implement"));
    assert.equal(env.calls.review, 1);
    assertCleanedUp(env);
  });

  it("2. a failing check fails the run and is named", { timeout: 30_000 }, async () => {
    const env = makeEnv({ checkResults: { lint: { exitCode: 1 } } });
    const outcome = await run(env);
    assert.equal(outcome.status, "failed");
    assert.deepEqual(outcome.missing, ['check "lint" exited with code 1']);
    assertTerminal(env, outcome);
    assertCleanedUp(env);
  });

  it("3. a timed-out check fails the run", { timeout: 30_000 }, async () => {
    const env = makeEnv({ checkResults: { test: { exitCode: null, timedOut: true } } });
    const outcome = await run(env);
    assert.equal(outcome.status, "failed");
    assert.deepEqual(outcome.missing, ['check "test" timed out']);
    assertTerminal(env, outcome);
  });

  it("4. request_changes fails the run", { timeout: 30_000 }, async () => {
    const env = makeEnv({ review: { verdict: "request_changes", findings: [] } });
    const outcome = await run(env);
    assert.equal(outcome.status, "failed");
    assert.deepEqual(outcome.missing, ["reviewer requested changes"]);
    assert.equal(outcome.facts.reviewVerdict, "request_changes");
    assertTerminal(env, outcome);
  });

  it("5. garbage review output fails with an error event", { timeout: 30_000 }, async () => {
    const env = makeEnv({ review: { foo: 1 } });
    const outcome = await run(env);
    assert.equal(outcome.status, "failed");
    assert.deepEqual(outcome.missing, ["no valid review"]);
    assert.equal(outcome.facts.reviewVerdict, null);
    const evs = await events(env);
    assert.ok(evs.some((e) => e.kind === "error" && e.agent === "reviewer"));
    assert.equal(evs.some((e) => e.kind === "review"), false);
    assertTerminal(env, outcome);
  });

  it("6. an empty diff fails and the reviewer is not called", { timeout: 30_000 }, async () => {
    const env = makeEnv({ diff: diffOf() });
    const outcome = await run(env);
    assert.equal(outcome.status, "failed");
    assert.ok(outcome.missing.includes("no changes were made"));
    assert.equal(env.calls.review, 0);
    assertTerminal(env, outcome);
  });

  it("7. a diff touching an excluded path fails and names it", { timeout: 30_000 }, async () => {
    const env = makeEnv({ diff: diffOf(file("src/a.ts"), file("secrets/leak.txt", true)) });
    const outcome = await run(env);
    assert.equal(outcome.status, "failed");
    assert.deepEqual(outcome.missing, ["excluded paths changed: secrets/leak.txt"]);
    assert.deepEqual(outcome.facts.excludedTouched, ["secrets/leak.txt"]);
    assertTerminal(env, outcome);
  });

  it("8. an implementer that exits 1 fails without checks or review", { timeout: 30_000 }, async () => {
    const env = makeEnv({ scenario: "fail" });
    const outcome = await run(env);
    assert.equal(outcome.status, "failed");
    assert.ok(outcome.missing.includes("implementer exited with code 1"));
    assert.deepEqual(env.calls.runCheck, []);
    assert.equal(env.calls.review, 0);
    assertTerminal(env, outcome);
    assertCleanedUp(env);
  });

  it("9. the agent claiming success does not outweigh a failed check", { timeout: 30_000 }, async () => {
    const env = makeEnv({ scenario: "success", checkResults: { test: { exitCode: 2 } } });
    const outcome = await run(env);
    const evs = await events(env);
    assert.ok(
      evs.some((e) => e.agent === "implementer" && JSON.stringify(e.payload).includes("Successfully")),
      "the agent did claim success",
    );
    assert.equal(outcome.facts.implementerExitCode, 0);
    assert.equal(outcome.status, "failed");
    assert.deepEqual(outcome.missing, ['check "test" exited with code 2']);
    assertTerminal(env, outcome);
  });

  it("10. stop during implement kills the child and cleans up", { timeout: 30_000 }, async () => {
    const env = makeEnv({ scenario: "hang", stopGraceMs: 500 });
    fs.mkdirSync(grantDirFor(env.runStore, env.runId), { recursive: true });
    setTimeout(() => env.controller.abort(), 500);
    const started = Date.now();
    const outcome = await run(env);
    assert.ok(Date.now() - started < 4000, "stop finishes quickly with stopGraceMs");
    assert.equal(outcome.status, "stopped");
    assert.deepEqual(outcome.missing, ["stopped by user"]);
    assertTerminal(env, outcome);
    assert.ok(env.calls.commit.includes("stopped"));
    const pid = env.calls.handles[0]?.pid;
    assert.ok(pid);
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "child process is gone");
    assertCleanedUp(env);
    assert.equal(env.calls.runCheck.length, 0);
    assert.equal(env.calls.review, 0);
  });

  it("11. stop before start never creates the worktree", { timeout: 30_000 }, async () => {
    const env = makeEnv();
    env.controller.abort();
    const outcome = await run(env);
    assert.equal(outcome.status, "stopped");
    assert.equal(env.calls.create, 0);
    assert.equal(fs.existsSync(path.join(env.worktreeRoot, env.runId)), false);
    assert.equal(env.calls.handles.length, 0);
    assertTerminal(env, outcome);
    assertCleanedUp(env);
  });

  it("12. a held workspace lock fails the run before create", { timeout: 30_000 }, async () => {
    const env = makeEnv();
    const otherId = `run-orch-other-${++counter}`;
    db.insert(agentRuns).values({ id: otherId, projectId: "prj-orch" }).run();
    const held = acquireWorkspaceLock(db, otherId, env.deps.workspace.pathFor(env.worktreeRoot, env.runId));
    assert.ok(held.ok);
    const outcome = await run(env);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.error ?? "", /locked/);
    assert.equal(env.calls.create, 0);
    const evs = await events(env);
    assert.ok(evs.some((e) => e.kind === "error" && JSON.stringify(e.payload).includes("locked")));
    assertTerminal(env, outcome);
    // The other run's lock is untouched.
    assert.equal(db.select().from(agentWorkspaceLocks).where(eq(agentWorkspaceLocks.runId, otherId)).all().length, 1);
  });

  it("13. an unknown check fails before the worktree is created", { timeout: 30_000 }, async () => {
    const env = makeEnv({ checks: ["lint", "nope"] });
    const outcome = await run(env);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.error ?? "", /nope/);
    assert.equal(env.calls.create, 0);
    assert.equal(env.calls.handles.length, 0);
    const evs = await events(env);
    assert.ok(evs.some((e) => e.kind === "error"));
    assertTerminal(env, outcome);
  });

  it("15. never deletes through a junction out of <runStore>/runs", { timeout: 30_000 }, async () => {
    const env = makeEnv();
    const outside = path.join(env.root, "outside folder");
    fs.mkdirSync(outside);
    const marker = path.join(outside, "marker.txt");
    fs.writeFileSync(marker, "keep me");
    fs.symlinkSync(outside, grantDirFor(env.runStore, env.runId), "junction");
    const outcome = await run(env);
    assert.equal(outcome.status, "succeeded");
    assert.equal(fs.existsSync(marker), true, "marker outside the run store survives");
    assert.equal(fs.readFileSync(marker, "utf8"), "keep me");
  });
});

describe("stop races (AW1-08 review fixes)", () => {
  it("R1. a stop during review can never end succeeded", { timeout: 30_000 }, async () => {
    const env = makeEnv({ onReview: (e) => e.controller.abort() });
    const outcome = await run(env);
    assert.equal(outcome.status, "stopped");
    assert.ok(env.calls.commit.includes("stopped"));
    assertTerminal(env, outcome);
    assertCleanedUp(env);
  });

  it("R1b. a stop while the review event is being stored still ends stopped", { timeout: 30_000 }, async () => {
    const env = makeEnv({ abortOnDbAfterReview: true });
    const outcome = await run(env);
    assert.equal(outcome.status, "stopped");
    assert.equal(outcome.facts.reviewVerdict, "approve", "the review itself was recorded");
    assert.ok(env.calls.commit.includes("stopped"));
    assertTerminal(env, outcome);
    assertCleanedUp(env);
  });

  it("R2. an already-aborted signal at spawn stops instead of hanging", { timeout: 30_000 }, async () => {
    const env = makeEnv({ scenario: "hang", stopGraceMs: 500, onSpawn: (e) => e.controller.abort() });
    const started = Date.now();
    const outcome = await run(env);
    assert.ok(Date.now() - started < 8000, "did not hang");
    assert.equal(outcome.status, "stopped");
    assertTerminal(env, outcome);
    assertCleanedUp(env);
  });

  it("R3. a stop during diff with an empty diff is stopped, not failed", { timeout: 30_000 }, async () => {
    const env = makeEnv({ diff: diffOf(), onDiff: (e) => e.controller.abort() });
    const outcome = await run(env);
    assert.equal(outcome.status, "stopped");
    assert.equal(env.calls.review, 0);
    assertTerminal(env, outcome);
  });

  it("R4. the lock and grant dir are gone before the terminal writes", { timeout: 30_000 }, async () => {
    const snaps: number[] = [];
    let lockDuringReview = -1;
    const env = makeEnv({
      lockSnapshots: snaps,
      onReview: (e) => {
        lockDuringReview = db.select().from(agentWorkspaceLocks).where(eq(agentWorkspaceLocks.runId, e.runId)).all().length;
      },
    });
    const outcome = await run(env);
    assert.equal(outcome.status, "succeeded");
    assert.equal(lockDuringReview, 1, "lock held during the run");
    assert.ok(snaps.length >= 3);
    assert.ok(snaps.slice(0, -2).includes(1), "lock held while the run was in progress");
    // The last two updates are the outcome row and the terminal status.
    assert.deepEqual(snaps.slice(-2), [0, 0], "lock released before the terminal writes");
    assertCleanedUp(env);
  });

  it("R5. a stopped run emits exactly one status_changed with status stopped", { timeout: 30_000 }, async () => {
    const env = makeEnv({ onReview: (e) => e.controller.abort() });
    await run(env);
    const evs = await events(env);
    const changes = evs.filter((e) => e.kind === "status_changed");
    assert.equal(changes.filter((e) => (e.payload as { status?: string }).status === "stopped").length, 1);
    assert.ok(changes.every((e) => typeof (e.payload as { status?: unknown }).status === "string"));
  });
});

describe("decide (AW1-08)", () => {
  const good = (): RunOutcome["facts"] => ({
    implementerExitCode: 0,
    diffFiles: 1,
    excludedTouched: [],
    checks: [
      { name: "lint", exitCode: 0, timedOut: false },
      { name: "test", exitCode: 0, timedOut: false },
    ],
    reviewVerdict: "approve",
  });
  const req = ["lint", "test"];

  it("succeeds with nothing missing when every fact holds", () => {
    assert.deepEqual(decide(good(), req), { status: "succeeded", missing: [] });
  });
  it("names a failing check", () => {
    const f = good();
    f.checks[0] = { name: "lint", exitCode: 1, timedOut: false };
    assert.deepEqual(decide(f, req).missing, ['check "lint" exited with code 1']);
  });
  it("names a timed-out check", () => {
    const f = good();
    f.checks[1] = { name: "test", exitCode: null, timedOut: true };
    assert.deepEqual(decide(f, req).missing, ['check "test" timed out']);
  });
  it("names a required check that never ran", () => {
    const f = good();
    f.checks = [];
    assert.deepEqual(decide(f, req).missing, ['check "lint" did not run', 'check "test" did not run']);
  });
  it("request_changes and missing review", () => {
    const f = good();
    f.reviewVerdict = "request_changes";
    assert.deepEqual(decide(f, req).missing, ["reviewer requested changes"]);
    f.reviewVerdict = null;
    assert.deepEqual(decide(f, req).missing, ["no valid review"]);
  });
  it("empty diff and excluded paths", () => {
    const f = good();
    f.diffFiles = 0;
    assert.deepEqual(decide(f, req).missing, ["no changes were made"]);
    const g = good();
    g.excludedTouched = ["a", "b"];
    assert.deepEqual(decide(g, req).missing, ["excluded paths changed: a, b"]);
  });
  it("implementer exit code (including null)", () => {
    const f = good();
    f.implementerExitCode = 1;
    assert.deepEqual(decide(f, req).missing, ["implementer exited with code 1"]);
    f.implementerExitCode = null;
    assert.deepEqual(decide(f, req).missing, ["implementer exited with code null"]);
  });
  it("combines every failure in a stable order", () => {
    const f: RunOutcome["facts"] = {
      implementerExitCode: 1,
      diffFiles: 0,
      excludedTouched: ["x"],
      checks: [{ name: "lint", exitCode: 3, timedOut: false }],
      reviewVerdict: null,
    };
    assert.deepEqual(decide(f, req), {
      status: "failed",
      missing: [
        "implementer exited with code 1",
        "no changes were made",
        "excluded paths changed: x",
        'check "lint" exited with code 3',
        'check "test" did not run',
        "no valid review",
      ],
    });
  });
  it("ignores checks that are not required", () => {
    const f = good();
    f.checks.push({ name: "extra", exitCode: 9, timedOut: false });
    assert.equal(decide(f, req).status, "succeeded");
  });
});

/**
 * Unit tests for the AW.2 plan stage and correction rounds (AW2-04).
 *
 * The implementer is the real credential-free fake agent process; git, checks
 * and the planner/reviewer (scripted fake role runner) are stubs the test controls.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db";
import { agentRuns, projects } from "../../src/db/schema";
import { readSince, type StoredAgentEvent } from "../../src/core/agents/events";
import { fakeAdapter } from "../../src/core/agents/adapters/fake";
import type { AgentAdapter } from "../../src/core/agents/adapters/types";
import { addComment } from "../../src/core/agents/comments";
import { createFakeRoleRunner, type FakeRoleScript } from "../../src/core/agents/role-runners";
import { spawnAgentProcess, stopAgentProcess, type AgentProcessHandle } from "../../src/core/agents/process";
import {
  runAgentRun,
  severityClass,
  triggersCorrection,
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
  db.insert(projects).values({ id: "prj-rounds", name: "Rounds" }).run();
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

const PLAN = { task: "do the thing", scope_paths: ["fake-output.txt"], acceptance: ["file exists"], checks: ["lint"] };
const APPROVE = { verdict: "approve", findings: [] };
const BLOCKING = {
  verdict: "request_changes",
  findings: [{ severity: "P1", path: "fake-output.txt", line: 1, message: "wrong content", actionable: true }],
};

function file(p: string): DiffSummaryFile {
  return { path: p, status: "added", additions: 1, deletions: 0, binary: false, outOfScope: false, excluded: false };
}
function diffOf(...files: DiffSummaryFile[]): DiffSummaryResult {
  return { files, totals: { files: files.length, additions: files.length, deletions: 0 } };
}
const ok = (name: string): CheckResult => ({ name, exitCode: 0, timedOut: false, durationMs: 1, output: "ok" });

interface Env {
  runId: string;
  root: string;
  deps: OrchestratorDeps;
  controller: AbortController;
  runner: ReturnType<typeof createFakeRoleRunner>;
  prompts: string[];
  calls: { create: number; spawns: AgentProcessHandle[]; commits: string[] };
}

interface Opts {
  roles?: Record<string, { provider: string }>;
  script?: FakeRoleScript;
  withoutRunners?: boolean;
  /** Result of a check on its Nth call (0-based, across rounds). */
  checkResult?: (name: string, call: number) => Partial<CheckResult>;
  diff?: (call: number) => DiffSummaryResult;
  onReview?: (env: Env, call: number) => Promise<void> | void;
  onSpawn?: (env: Env, spawnIndex: number) => void;
}

function makeEnv(opts: Opts = {}): Env {
  const runId = `run-rounds-${++counter}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rounds test "));
  tempDirs.push(root);
  const runStore = path.join(root, "run store");
  const worktreeRoot = path.join(root, "work trees");
  fs.mkdirSync(path.join(runStore, "runs"), { recursive: true });
  fs.mkdirSync(worktreeRoot, { recursive: true });
  const request = {
    projectId: "prj-rounds",
    task: "do the thing",
    roles: {
      implementer: { provider: "fake", model: "success" },
      ...(opts.roles ?? { planner: { provider: "fake" }, reviewer: { provider: "fake" } }),
    },
    checks: ["lint", "test"],
  };
  db.insert(agentRuns).values({ id: runId, projectId: "prj-rounds", request: JSON.stringify(request) }).run();

  const runner = createFakeRoleRunner(opts.script ?? { plan: { output: PLAN }, reviews: [{ output: APPROVE }] });
  const calls: Env["calls"] = { create: 0, spawns: [], commits: [] };
  const prompts: string[] = [];
  const controller = new AbortController();
  const wtPath = (r: string) => path.join(worktreeRoot, r);
  const checkCalls = new Map<string, number>();
  let reviewCall = 0;
  let diffCall = 0;
  let envRef: Env | undefined;
  const implementer: AgentAdapter = {
    ...fakeAdapter,
    buildInvocation: (req) => {
      prompts.push(req.prompt);
      return fakeAdapter.buildInvocation(req);
    },
  };
  const deps: OrchestratorDeps = {
    db,
    implementer,
    review: async () => APPROVE,
    roleRunners: opts.withoutRunners
      ? {}
      : {
          fake: {
            runPlanner: (i, s) => runner.runPlanner(i, s),
            runReviewer: async (i, s) => {
              await opts.onReview?.(envRef!, reviewCall++);
              return runner.runReviewer(i, s);
            },
          },
        },
    workspace: {
      create: async ({ runId: r }) => {
        calls.create++;
        fs.mkdirSync(wtPath(r), { recursive: true });
        return { path: wtPath(r), branch: `agent/${r}`, baseSha: "a".repeat(40) };
      },
      commit: async (_p, stage) => {
        calls.commits.push(stage);
        return "b".repeat(40);
      },
      diff: async () => (opts.diff ? opts.diff(diffCall++) : diffOf(file("fake-output.txt"))),
      patch: async () => ({ files: [], truncated: false }),
      pathFor: (_root, r) => wtPath(r),
      shortId: (r) => r.slice(-6),
    },
    spawn: (o) => {
      const h = spawnAgentProcess(o);
      calls.spawns.push(h);
      opts.onSpawn?.(envRef!, calls.spawns.length - 1);
      return h;
    },
    stop: (h, o) => stopAgentProcess(h, o),
    runCheck: async (check: PolicyCheck) => {
      const n = checkCalls.get(check.name) ?? 0;
      checkCalls.set(check.name, n + 1);
      return { ...ok(check.name), ...(opts.checkResult?.(check.name, n) ?? {}) };
    },
    storage: { worktreeRoot, runStore },
    signal: controller.signal,
    stopGraceMs: 200,
  };
  envRef = { runId, root, deps, controller, runner, prompts, calls };
  return envRef;
}

const run = (env: Env): Promise<RunOutcome> =>
  runAgentRun(env.deps, { runId: env.runId, repoPath: path.join(env.root, "repo"), policy: POLICY });
const events = (env: Env): Promise<StoredAgentEvent[]> => readSince(db, env.runId, 0, 5000);
const reviewCalls = (env: Env) => env.runner.calls.filter((c) => c.role === "reviewer");
const T = { timeout: 60_000 };

describe("severity mapping", () => {
  it("maps P1 to blocking, P2 to major, P3 to minor in one place", () => {
    assert.equal(severityClass("P1"), "blocking");
    assert.equal(severityClass("P2"), "major");
    assert.equal(severityClass("P3"), "minor");
    const base = { message: "m", actionable: true };
    assert.equal(triggersCorrection({ ...base, severity: "P1" }), true);
    assert.equal(triggersCorrection({ ...base, severity: "P2" }), true);
    assert.equal(triggersCorrection({ ...base, severity: "P3" }), false);
    assert.equal(triggersCorrection({ ...base, severity: "P1", actionable: false }), false);
  });
});

describe("runAgentRun rounds (AW2-04)", () => {
  it("happy path: plan, implement, approve, succeeded with no corrections", T, async () => {
    const env = makeEnv();
    const out = await run(env);
    assert.equal(out.status, "succeeded", JSON.stringify(out));
    assert.deepEqual(out.rounds, { corrections: 0 });
    assert.equal(env.calls.spawns.length, 1);
    assert.equal(env.runner.calls.filter((c) => c.role === "planner").length, 1);
    assert.match(env.prompts[0] ?? "", /<plan>/);
    assert.match(env.prompts[0] ?? "", /fake-output\.txt/);
    const evs = await events(env);
    const stages = evs.filter((e) => e.kind === "stage_started").map((e) => e.stage);
    assert.deepEqual(stages, ["plan", "implement", "checks", "review"]);
  });

  it("one blocking finding: one correction round, then approve", T, async () => {
    const env = makeEnv({ script: { plan: { output: PLAN }, reviews: [{ output: BLOCKING }, { output: APPROVE }] } });
    const out = await run(env);
    assert.equal(out.status, "succeeded", JSON.stringify(out));
    assert.deepEqual(out.rounds, { corrections: 1 });
    assert.equal(env.calls.spawns.length, 2);
    assert.match(env.prompts[1] ?? "", /correction round 1/);
    assert.match(env.prompts[1] ?? "", /\[P1\] fake-output\.txt:1: wrong content/);
    assert.equal(reviewCalls(env).length, 2);
    assert.deepEqual(reviewCalls(env).map((c) => c.round), [0, 1]);
    assert.deepEqual(env.calls.commits, ["implement", "correct"]);
  });

  it("a malformed review fails the run with no retry", T, async () => {
    const env = makeEnv({ script: { plan: { output: PLAN }, reviews: [{ output: { verdict: "maybe", findings: [] } }] } });
    const out = await run(env);
    assert.equal(out.status, "failed");
    assert.deepEqual(out.missing, ["no valid review"]);
    assert.equal(reviewCalls(env).length, 1);
    assert.equal(env.calls.spawns.length, 1);
  });

  it("a missing review (runner failure) fails the run with no retry", T, async () => {
    const env = makeEnv({ script: { plan: { output: PLAN }, reviews: [{ failure: "codex timed out" }] } });
    const out = await run(env);
    assert.equal(out.status, "failed");
    assert.match(out.missing[0] ?? "", /no valid review: codex timed out/);
    assert.equal(reviewCalls(env).length, 1);
  });

  it("three failing rounds fail the run and exactly 3 correction rounds ran", T, async () => {
    const env = makeEnv({ script: { plan: { output: PLAN }, reviews: [{ output: BLOCKING }] } });
    const out = await run(env);
    assert.equal(out.status, "failed");
    assert.deepEqual(out.rounds, { corrections: 3 });
    assert.equal(env.calls.spawns.length, 4, "initial implement plus three corrections");
    assert.equal(reviewCalls(env).length, 4);
    assert.match(out.missing.join("|"), /still not done after 3 correction rounds/);
    assert.match(out.missing.join("|"), /open actionable finding/);
    const evs = await events(env);
    assert.equal(evs.filter((e) => e.stage === "correct" && e.kind === "stage_started" && (e.payload as { findings?: number }).findings !== undefined).length, 3);
  });

  it("a user comment alone starts a correction round and is labelled as the user's", T, async () => {
    const env = makeEnv({
      onReview: async (e, call) => {
        if (call === 0) await addComment(db, e.runId, { round: 0, file: "fake-output.txt", line: 2, body: "please rename this" });
      },
    });
    const out = await run(env);
    assert.equal(out.status, "succeeded", JSON.stringify(out));
    assert.deepEqual(out.rounds, { corrections: 1 });
    assert.match(env.prompts[1] ?? "", /from the user \(owner\) \(fake-output\.txt:2\): please rename this/);
    // The reviewer's verdict was approve both times: the comment never entered a review.
    assert.match(env.prompts[1] ?? "", /<findings>\s*\(none\)\s*<\/findings>/);
  });

  it("a failing required check starts a correction round", T, async () => {
    const env = makeEnv({
      checkResult: (name, call) => (name === "test" && call === 0 ? { exitCode: 1, output: "boom in test" } : {}),
    });
    const out = await run(env);
    assert.equal(out.status, "succeeded", JSON.stringify(out));
    assert.deepEqual(out.rounds, { corrections: 1 });
    assert.match(env.prompts[1] ?? "", /test: exit 1/);
    assert.match(env.prompts[1] ?? "", /boom in test/);
  });

  it("a check still failing after round 3 is named in the failure", T, async () => {
    const env = makeEnv({ checkResult: (name) => (name === "lint" ? { exitCode: 2 } : {}) });
    const out = await run(env);
    assert.equal(out.status, "failed");
    assert.deepEqual(out.rounds, { corrections: 3 });
    assert.ok(out.missing.includes('check "lint" exited with code 2'), out.missing.join("|"));
  });

  it("approve with only minor or non-actionable findings succeeds", T, async () => {
    const review = {
      verdict: "approve",
      findings: [
        { severity: "P3", message: "nit", actionable: true },
        { severity: "P1", message: "fyi", actionable: false },
      ],
    };
    const env = makeEnv({ script: { plan: { output: PLAN }, reviews: [{ output: review }] } });
    const out = await run(env);
    assert.equal(out.status, "succeeded", JSON.stringify(out));
    assert.equal(env.calls.spawns.length, 1);
  });

  it("request_changes with nothing that triggers a round fails without correcting", T, async () => {
    const review = { verdict: "request_changes", findings: [{ severity: "P3", message: "meh", actionable: true }] };
    const env = makeEnv({ script: { plan: { output: PLAN }, reviews: [{ output: review }] } });
    const out = await run(env);
    assert.equal(out.status, "failed");
    assert.deepEqual(out.missing, ["reviewer requested changes"]);
    assert.equal(env.calls.spawns.length, 1);
  });

  it("an out-of-scope path starts a correction round; reverting it succeeds", T, async () => {
    let diffs = 0;
    const env = makeEnv({
      diff: () => (diffs++ === 0 ? diffOf(file("fake-output.txt"), file("src/other.ts")) : diffOf(file("fake-output.txt"))),
    });
    const out = await run(env);
    assert.equal(out.status, "succeeded");
    assert.equal(env.calls.spawns.length, 2);
  });

  it("a path that stays outside the plan scope fails after the last round", T, async () => {
    const env = makeEnv({ diff: () => diffOf(file("fake-output.txt"), file("src/other.ts")) });
    const out = await run(env);
    assert.equal(out.status, "failed");
    assert.deepEqual(out.facts.outOfScope, ["src/other.ts"]);
    assert.match(out.missing.join("|"), /outside the plan scope: src\/other\.ts/);
    assert.equal(env.calls.spawns.length, 4);
  });

  it("approve with an empty diff fails and the reviewer is not asked", T, async () => {
    const env = makeEnv({ diff: () => diffOf() });
    const out = await run(env);
    assert.equal(out.status, "failed");
    assert.deepEqual(out.missing, ["no changes were made"]);
    assert.equal(reviewCalls(env).length, 0);
  });

  it("an invalid plan fails before the implementer starts", T, async () => {
    const env = makeEnv({ script: { plan: { output: { task: "x", scope_paths: "nope" } }, reviews: [{ output: APPROVE }] } });
    const out = await run(env);
    assert.equal(out.status, "failed");
    assert.match(out.missing[0] ?? "", /no valid plan/);
    assert.equal(env.calls.spawns.length, 0);
  });

  it("a plan with no scope paths, or a planner failure, fails the run", T, async () => {
    const empty = makeEnv({ script: { plan: { output: { ...PLAN, scope_paths: [] } } } });
    const a = await run(empty);
    assert.equal(a.status, "failed");
    assert.match(a.missing[0] ?? "", /no scope_paths/);
    const missing = makeEnv({ script: { plan: { failure: "planner offline" } } });
    const b = await run(missing);
    assert.equal(b.status, "failed");
    assert.match(b.missing[0] ?? "", /no valid plan: planner offline/);
    assert.equal(empty.calls.spawns.length + missing.calls.spawns.length, 0);
  });

  it("a role whose provider has no runner fails up front, before the worktree", T, async () => {
    const env = makeEnv({ withoutRunners: true });
    const out = await run(env);
    assert.equal(out.status, "failed");
    assert.match(out.error ?? "", /no runner is available for provider "fake" \(planner role\)/);
    assert.equal(env.calls.create, 0);
    assert.equal(env.calls.spawns.length, 0);
  });

  it("an unknown reviewer provider fails up front even when the planner is fine", T, async () => {
    const env = makeEnv({ roles: { planner: { provider: "fake" }, reviewer: { provider: "codex" } } });
    const out = await run(env);
    assert.equal(out.status, "failed");
    assert.match(out.error ?? "", /provider "codex" \(reviewer role\)/);
    assert.equal(env.calls.create, 0);
  });

  it("stop during a correction round ends stopped and runs no further round", T, async () => {
    const env = makeEnv({
      script: { plan: { output: PLAN }, reviews: [{ output: BLOCKING }] },
      onSpawn: (e, i) => {
        if (i === 1) setTimeout(() => e.controller.abort(), 50);
      },
    });
    // The second spawn is the correction; make it hang so the abort lands mid-process.
    const origBuild = env.deps.implementer.buildInvocation;
    let builds = 0;
    env.deps.implementer = {
      ...env.deps.implementer,
      buildInvocation: (req) => {
        const inv = origBuild(req);
        if (++builds === 2) inv.env = { ...inv.env, FAKE_AGENT_SCENARIO: "hang" };
        return inv;
      },
    };
    const out = await run(env);
    assert.equal(out.status, "stopped", JSON.stringify(out));
    assert.equal(env.calls.spawns.length, 2);
    assert.equal(env.calls.commits.at(-1), "stopped");
    const row = db.select().from(agentRuns).where(eq(agentRuns.id, env.runId)).get();
    assert.equal(row?.status, "stopped");
  });

  it("stop during the planner ends stopped before the implementer", T, async () => {
    const env = makeEnv();
    const original = env.deps.roleRunners!.fake!;
    env.deps = {
      ...env.deps,
      roleRunners: {
        fake: {
          ...original,
          runPlanner: async (i, s) => {
            env.controller.abort();
            return original.runPlanner(i, s);
          },
        },
      },
    };
    const out = await run(env);
    assert.equal(out.status, "stopped");
    assert.equal(env.calls.spawns.length, 0);
  });

  it("events carry the round number, bounded, and statuses show correcting", T, async () => {
    const env = makeEnv({ script: { plan: { output: PLAN }, reviews: [{ output: BLOCKING }, { output: APPROVE }] } });
    const out = await run(env);
    assert.equal(out.status, "succeeded");
    const evs = await events(env);
    for (const e of evs) {
      const r = (e.payload as { round?: unknown }).round;
      assert.ok(typeof r === "number" && r >= 0 && r <= 3, `event ${e.seq} ${e.kind} has round ${String(r)}`);
    }
    const roundsOf = (kind: string, stage: string) =>
      evs.filter((e) => e.kind === kind && e.stage === stage).map((e) => (e.payload as { round: number }).round);
    assert.deepEqual(roundsOf("review", "review"), [0, 1]);
    assert.deepEqual(roundsOf("check_result", "checks"), [0, 0, 1, 1]);
    const correcting = evs.find((e) => e.kind === "status_changed" && (e.payload as { status?: string }).status === "correcting");
    assert.equal((correcting?.payload as { round: number }).round, 1);
    const last = evs.filter((e) => e.kind === "status_changed").at(-1);
    assert.deepEqual({ s: (last?.payload as { status: string }).status, r: (last?.payload as { round: number }).round }, { s: "succeeded", r: 1 });
  });
});

describe("runs without planner or reviewer roles keep the AW.1 flow", () => {
  it("one pass through deps.review, no round fields, no plan stage", T, async () => {
    const env = makeEnv({ roles: {} });
    const out = await run(env);
    assert.equal(out.status, "succeeded", JSON.stringify(out));
    assert.equal(out.rounds, undefined);
    assert.equal(env.prompts[0], "do the thing");
    const evs = await events(env);
    assert.ok(evs.every((e) => (e.payload as { round?: unknown }).round === undefined));
    assert.equal(evs.some((e) => e.kind === "stage_started"), false);
  });
});

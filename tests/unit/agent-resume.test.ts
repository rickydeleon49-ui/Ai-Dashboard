/**
 * Explicit Resume (AW4-07): refused unless the run is interrupted/failed/stopped and its
 * worktree is exactly where the run left it; the work only ever happens in the runner.
 *
 * Real temp git repos (folders with spaces), the fake agent, no network.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db";
import { agentRunApprovals, agentRunIntents, agentRuns, agentWorkspaceLocks, projects } from "../../src/db/schema";
import { antigravityAdapter } from "../../src/core/agents/adapters/antigravity";
import { claudeAdapter } from "../../src/core/agents/adapters/claude-code";
import { fakeAdapter } from "../../src/core/agents/adapters/fake";
import type { AgentAdapter, InvocationRequest } from "../../src/core/agents/adapters/types";
import { appendEvent, readSince } from "../../src/core/agents/events";
import { acquireWorkspaceLock } from "../../src/core/agents/roots";
import { checkResumable, requestResume } from "../../src/core/agents/resume";
import { createIntent } from "../../src/core/agents/runs";
import { createRunWorkspace } from "../../src/core/agents/snapshot";
import { commitStage, shortRunId } from "../../src/core/agents/workspace";
import { createRunner, type LogFn } from "../../runner/index";

let db: typeof import("../../src/db/client").db;
const tempDirs: string[] = [];
let counter = 0;

const SESSION = "123e4567-e89b-42d3-a456-426614174000";
const TASK = "add a file\nwith details";

before(async () => {
  await migrate();
  ({ db } = await import("../../src/db/client"));
});

after(async () => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  await cleanup();
});

const silent: LogFn = () => {};

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.local", "-c", "core.autocrlf=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

interface Fx {
  workspaceRoot: string;
  repo: string;
  worktreeRoot: string;
  runStore: string;
  projectId: string;
}

function makeFx(): Fx {
  const n = ++counter;
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "resume test ")));
  tempDirs.push(root);
  const workspaceRoot = path.join(root, "work spaces");
  const repo = path.join(workspaceRoot, "my repo");
  const worktreeRoot = path.join(root, "work trees");
  const runStore = path.join(root, "run store");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(worktreeRoot, { recursive: true });
  fs.mkdirSync(runStore, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# hi\n");
  git(repo, "init", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "user.name", "Test Owner");
  git(repo, "config", "user.email", "owner@example.local");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  const projectId = `prj-resume-${n}`;
  db.insert(projects).values({ id: projectId, name: `Resume ${n}`, localPath: repo }).run();
  return { workspaceRoot, repo, worktreeRoot, runStore, projectId };
}

interface MadeRun {
  id: string;
  worktree: string;
}

/**
 * A run that stopped after `lastStage`: a real worktree, the events a real run leaves, and (for
 * "implement") a stage commit named like the runner's own.
 */
async function makeRun(
  fx: Fx,
  opts: { status?: string; lastStage?: "inspect" | "implement"; session?: string } = {},
): Promise<MadeRun> {
  const id = `run-resume-${++counter}`;
  const lastStage = opts.lastStage ?? "implement";
  const ws = await createRunWorkspace({ repoPath: fx.repo, worktreeRoot: fx.worktreeRoot, runId: id });
  const request = {
    projectId: fx.projectId,
    task: TASK,
    roles: { implementer: { provider: "fake", model: "success" } },
    checks: [],
  };
  db.insert(agentRuns)
    .values({
      id,
      projectId: fx.projectId,
      status: opts.status ?? "interrupted",
      stage: "implement",
      request: JSON.stringify(request),
      workspaceKind: ws.kind,
      workspacePath: ws.path,
      baseRef: ws.baseSha,
      branch: ws.branch,
    })
    .run();
  const ev = (stage: string, agent: "system" | "implementer", kind: "stage_finished" | "output", payload: unknown) =>
    appendEvent(db, { runId: id, stage: stage as never, agent, kind, payload });
  await ev("inspect", "system", "stage_finished", { stage: "inspect", workspacePath: ws.path, baseSha: ws.baseSha });
  if (opts.session) await ev("implement", "implementer", "output", { sessionId: opts.session, model: "m" });
  if (lastStage === "implement") {
    fs.writeFileSync(path.join(ws.path, "feature.txt"), "feature\n");
    await commitStage(ws.path, "implement", shortRunId(id));
    await ev("implement", "system", "stage_finished", { stage: "implement", exitCode: 0, signal: null });
  }
  return { id, worktree: ws.path };
}

function makeRunner(fx: Fx, implementer: AgentAdapter = fakeAdapter) {
  return createRunner({
    db,
    epoch: `epoch-${++counter}`,
    log: silent,
    implementer,
    getStorage: async () => ({
      workspaceRoots: [fx.workspaceRoot],
      worktreeRoot: fx.worktreeRoot,
      runStore: fx.runStore,
    }),
    orchestrator: { review: async () => ({ verdict: "approve", findings: [] }), stopGraceMs: 500 },
    stopGraceMs: 500,
  });
}

/** An adapter that records what it is asked to build, then behaves like the fake agent. */
function recordingAdapter(): AgentAdapter & { calls: InvocationRequest[] } {
  const calls: InvocationRequest[] = [];
  return {
    ...fakeAdapter,
    calls,
    buildInvocation(req) {
      calls.push(req);
      return fakeAdapter.buildInvocation(req);
    },
  };
}

function statusOf(id: string): string | undefined {
  return db.select().from(agentRuns).where(eq(agentRuns.id, id)).get()?.status;
}

async function messages(id: string): Promise<string[]> {
  return (await readSince(db, id, 0, 1000))
    .map((e) => (e.payload as { message?: unknown } | null)?.message)
    .filter((m): m is string => typeof m === "string");
}

describe("checkResumable", () => {
  it("is resumable after interrupted, from the last completed stage, with the recorded session", async () => {
    const fx = makeFx();
    const run = await makeRun(fx, { session: SESSION });
    const res = await checkResumable(db, run.id);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.fromStage, "implement");
    assert.equal(res.startAt, "checks");
    assert.equal(res.sessionIds.implementer, SESSION);
    // The check takes the repo lock only to look; it never keeps it.
    assert.equal(db.select().from(agentWorkspaceLocks).where(eq(agentWorkspaceLocks.runId, run.id)).all().length, 0);
  });

  it("is resumable for failed and stopped runs too, and starts a fresh stage with no session", async () => {
    const fx = makeFx();
    for (const status of ["failed", "stopped"]) {
      const run = await makeRun(fx, { status, lastStage: "inspect" });
      const res = await checkResumable(db, run.id);
      assert.equal(res.ok, true, status);
      if (res.ok) {
        assert.equal(res.startAt, "implement");
        assert.deepEqual(res.sessionIds, {});
      }
    }
  });

  it("ignores a session id that is not a UUID", async () => {
    const fx = makeFx();
    const run = await makeRun(fx, { session: "fake-session-success" });
    const res = await checkResumable(db, run.id);
    assert.equal(res.ok && res.sessionIds.implementer, undefined);
  });

  it("is refused for running, queued and succeeded runs", async () => {
    const fx = makeFx();
    for (const status of ["running", "implementing", "queued", "succeeded"]) {
      const run = await makeRun(fx, { status });
      const res = await checkResumable(db, run.id);
      assert.equal(res.ok, false, status);
      if (!res.ok) assert.match(res.reason, /interrupted, failed or stopped/);
    }
  });

  it("is refused for a missing run, a missing worktree and a run with no completed stage", async () => {
    const fx = makeFx();
    assert.equal((await checkResumable(db, "nope")).ok, false);
    const gone = await makeRun(fx);
    fs.rmSync(gone.worktree, { recursive: true, force: true });
    assert.equal((await checkResumable(db, gone.id)).ok, false);

    const live = await makeRun(fx, { lastStage: "inspect" });
    const id = `run-resume-${++counter}`;
    db.insert(agentRuns)
      .values({
        id,
        projectId: fx.projectId,
        status: "interrupted",
        request: JSON.stringify({ projectId: fx.projectId, task: TASK, roles: { implementer: { provider: "fake" } }, checks: [] }),
        workspacePath: live.worktree,
        baseRef: "HEAD",
      })
      .run();
    const res = await checkResumable(db, id);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /no completed stage/);
  });

  it("is refused after a commit made outside the run, naming its path", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    fs.writeFileSync(path.join(run.worktree, "outside.txt"), "x\n");
    git(run.worktree, "add", "-A");
    git(run.worktree, "commit", "-m", "someone else");
    const res = await checkResumable(db, run.id);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.match(res.reason, /not from this run/);
      assert.match(res.reason, /outside\.txt/);
    }
  });

  it("is refused after an outside uncommitted edit and after an untracked file", async () => {
    const fx = makeFx();
    const edited = await makeRun(fx);
    fs.writeFileSync(path.join(edited.worktree, "README.md"), "# changed\n");
    const r1 = await checkResumable(db, edited.id);
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.match(r1.reason, /README\.md/);

    const untracked = await makeRun(fx);
    fs.writeFileSync(path.join(untracked.worktree, "scratch.txt"), "x\n");
    const r2 = await checkResumable(db, untracked.id);
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.match(r2.reason, /scratch\.txt/);
  });

  it("lists at most 10 paths", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(run.worktree, `extra-${String(i).padStart(2, "0")}.txt`), "x\n");
    const res = await checkResumable(db, run.id);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal((res.reason.match(/extra-\d\d\.txt/g) ?? []).length, 10);
      assert.match(res.reason, /and 2 more/);
    }
  });

  it("ignores heavy folders the run itself skips", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    fs.mkdirSync(path.join(run.worktree, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(run.worktree, "node_modules", "pkg", "index.js"), "x\n");
    assert.equal((await checkResumable(db, run.id)).ok, true);
  });

  it("is refused while an approval is open, and allowed again once it is decided", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    const approvalId = `appr-resume-${++counter}`;
    db.insert(agentRunApprovals).values({ id: approvalId, runId: run.id, kind: "merge", status: "pending" }).run();
    const open = await checkResumable(db, run.id);
    assert.equal(open.ok, false);
    if (!open.ok) assert.match(open.reason, /approval/);
    db.update(agentRunApprovals).set({ status: "rejected" }).where(eq(agentRunApprovals.id, approvalId)).run();
    assert.equal((await checkResumable(db, run.id)).ok, true);
  });

  it("is refused while another run holds the repo lock", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    const other = await makeRun(fx, { status: "running" });
    const held = acquireWorkspaceLock(db, other.id, run.worktree);
    assert.equal(held.ok, true);
    const res = await checkResumable(db, run.id);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /locked/);
  });
});

describe("session ids reach each adapter", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "resume ws "));
  const grant = fs.mkdtempSync(path.join(os.tmpdir(), "resume grant "));
  tempDirs.push(ws, grant);
  const base = { workspacePath: ws, prompt: "p", checkCommands: [], excludedPaths: [], grantDir: grant };

  it("Claude Code gets --resume <id>", () => {
    const inv = claudeAdapter.buildInvocation({ ...base, resumeSessionId: SESSION });
    const i = inv.args.indexOf("--resume");
    assert.ok(i >= 0);
    assert.equal(inv.args[i + 1], SESSION);
    assert.equal(claudeAdapter.buildInvocation(base).args.includes("--resume"), false);
  });

  it("Antigravity gets --conversation <id>", () => {
    const inv = antigravityAdapter.buildInvocation({ ...base, resumeSessionId: SESSION });
    const i = inv.args.indexOf("--conversation");
    assert.ok(i >= 0);
    assert.equal(inv.args[i + 1], SESSION);
  });
});

describe("resume runs only through the runner intent", () => {
  it("the request only queues an intent: nothing changes until the runner takes it", async () => {
    const fx = makeFx();
    const adapter = recordingAdapter();
    const runner = makeRunner(fx, adapter);
    const run = await makeRun(fx, { lastStage: "inspect", session: SESSION });
    const headBefore = git(run.worktree, "rev-parse", "HEAD");

    const queued = await requestResume(db, run.id);
    assert.equal(queued.ok, true);
    assert.equal(statusOf(run.id), "interrupted");
    assert.equal(adapter.calls.length, 0);
    assert.equal(git(run.worktree, "rev-parse", "HEAD"), headBefore);
    const intents = db.select().from(agentRunIntents).where(eq(agentRunIntents.runId, run.id)).all();
    assert.deepEqual(intents.map((i) => i.kind), ["resume"]);
    assert.ok((await messages(run.id)).some((m) => /resume requested/.test(m)));
    // A second request while one is queued is refused.
    assert.equal((await requestResume(db, run.id)).ok, false);

    await runner.tick();
    await runner.idle();
    assert.equal(adapter.calls.length, 1);
    assert.equal(statusOf(run.id), "succeeded");
    assert.ok((await messages(run.id)).some((m) => /resumed from the inspect stage/.test(m)));
    // The same worktree was reused.
    assert.equal(db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).get()?.workspacePath, run.worktree);
  });

  it("passes the recorded session id to the adapter with a short continue note", async () => {
    const fx = makeFx();
    const adapter = recordingAdapter();
    const runner = makeRunner(fx, adapter);
    const run = await makeRun(fx, { lastStage: "inspect", session: SESSION });
    await createIntent(db, run.id, "resume", {});
    await runner.tick();
    await runner.idle();
    const req = adapter.calls[0];
    assert.ok(req);
    assert.equal(req.resumeSessionId, SESSION);
    assert.match(req.prompt, /resumed attempt/);
  });

  it("without a session the stage starts fresh: original prompt plus the resumed-attempt note", async () => {
    const fx = makeFx();
    const adapter = recordingAdapter();
    const runner = makeRunner(fx, adapter);
    const run = await makeRun(fx, { lastStage: "inspect" });
    await createIntent(db, run.id, "resume", {});
    await runner.tick();
    await runner.idle();
    const req = adapter.calls[0];
    assert.ok(req);
    assert.equal(req.resumeSessionId, undefined);
    assert.ok(req.prompt.startsWith(TASK));
    assert.match(req.prompt, /resumed attempt/);
  });

  it("a finished implement stage is not run again: the resume starts at the checks", async () => {
    const fx = makeFx();
    const adapter = recordingAdapter();
    const runner = makeRunner(fx, adapter);
    const run = await makeRun(fx, { lastStage: "implement", session: SESSION });
    await createIntent(db, run.id, "resume", {});
    await runner.tick();
    await runner.idle();
    assert.equal(adapter.calls.length, 0);
    assert.equal(statusOf(run.id), "succeeded");
  });

  it("the runner re-checks: a run whose worktree changed after the request is left as it was", async () => {
    const fx = makeFx();
    const adapter = recordingAdapter();
    const runner = makeRunner(fx, adapter);
    const run = await makeRun(fx, { lastStage: "inspect" });
    await createIntent(db, run.id, "resume", {});
    fs.writeFileSync(path.join(run.worktree, "late.txt"), "x\n");
    await runner.tick();
    await runner.idle();
    assert.equal(adapter.calls.length, 0);
    assert.equal(statusOf(run.id), "interrupted");
    assert.ok((await messages(run.id)).some((m) => /resume refused:.*late\.txt/.test(m)));
  });

  it("a refused request appends the reason and queues nothing", async () => {
    const fx = makeFx();
    const run = await makeRun(fx, { status: "succeeded" });
    const res = await requestResume(db, run.id);
    assert.equal(res.ok, false);
    assert.equal(db.select().from(agentRunIntents).where(eq(agentRunIntents.runId, run.id)).all().length, 0);
    assert.ok((await messages(run.id)).some((m) => /resume refused/.test(m)));
  });
});

/**
 * Dismiss + worktree retention (AW4-11).
 *
 * Real temp git repos (folders with spaces); no network. Cleanup removes worktrees
 * only for dismissed runs, never forces, never deletes an unmerged branch.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db";
import { agentRunApprovals, agentRunEvents, agentRunIntents, agentRuns, projects } from "../../src/db/schema";
import { DismissError, dismissRun, undismissRun } from "../../src/core/agents/dismiss";
import { applyRetention, planRetention, type RetentionDeps } from "../../src/core/agents/retention";
import { getRetentionDays, setRetentionDays } from "../../src/core/agents/roots";
import { listRuns } from "../../src/core/agents/runs";
import { createRunWorkspace } from "../../src/core/agents/snapshot";
import { createRunner, runRetentionPass, type LogFn } from "../../runner/index";

let db: typeof import("../../src/db/client").db;
const tempDirs: string[] = [];
let counter = 0;

before(async () => {
  await migrate();
  ({ db } = await import("../../src/db/client"));
});

after(async () => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  await cleanup();
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-30T12:00:00.000Z");
const OLD = new Date(NOW.getTime() - 10 * DAY).toISOString();
const RECENT = new Date(NOW.getTime() - 2 * DAY).toISOString();

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.local", "-c", "core.autocrlf=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

interface Fx {
  root: string;
  repo: string;
  worktreeRoot: string;
  projectId: string;
  deps: (days: number | null) => RetentionDeps;
}

function makeFx(opts: { git?: boolean } = {}): Fx {
  const n = ++counter;
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "retention test ")));
  tempDirs.push(root);
  const repo = path.join(root, "work spaces", "my repo");
  const worktreeRoot = path.join(root, "work trees");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(worktreeRoot, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# hi\n");
  if (opts.git !== false) {
    git(repo, "init", "-b", "main");
    git(repo, "config", "core.autocrlf", "false");
    git(repo, "config", "user.name", "Test Owner");
    git(repo, "config", "user.email", "owner@example.local");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "initial");
  }
  const projectId = `prj-ret-${n}`;
  db.insert(projects).values({ id: projectId, name: `Ret ${n}`, localPath: repo }).run();
  return {
    root,
    repo,
    worktreeRoot,
    projectId,
    deps: (days) => ({
      getStorage: async () => ({ worktreeRoot, retentionDays: days }),
      repoPathFor: async () => repo,
    }),
  };
}

/** A finished run with a real workspace and one committed change. */
async function makeRun(
  fx: Fx,
  extra: Partial<typeof agentRuns.$inferInsert> = {},
): Promise<{ id: string; worktree: string; branch: string }> {
  const id = `run-ret-${++counter}`;
  const ws = await createRunWorkspace({ repoPath: fx.repo, worktreeRoot: fx.worktreeRoot, runId: id });
  fs.writeFileSync(path.join(ws.path, "feature.txt"), "feature\n");
  git(ws.path, "add", "-A");
  git(ws.path, "commit", "-m", "agent: add feature");
  db.insert(agentRuns)
    .values({
      id,
      projectId: fx.projectId,
      status: "succeeded",
      stage: "final",
      request: JSON.stringify({ projectId: fx.projectId, task: "t", roles: { implementer: { provider: "fake" } }, checks: [] }),
      workspaceKind: ws.kind,
      workspacePath: ws.path,
      baseRef: ws.baseSha,
      branch: ws.branch,
      dismissedAt: OLD,
      ...extra,
    })
    .run();
  return { id, worktree: ws.path, branch: ws.branch };
}

function row(id: string) {
  const r = db.select().from(agentRuns).where(eq(agentRuns.id, id)).get();
  assert.ok(r);
  return r;
}

function branchExists(repo: string, branch: string): boolean {
  return git(repo, "branch", "--list", branch) !== "";
}

function addApproval(runId: string, kind: string, status: string): void {
  db.insert(agentRunApprovals).values({ id: `appr-${++counter}`, runId, kind, status }).run();
}

describe("dismiss", () => {
  it("dismisses a finished run, hides it from the default list, and restores it", async () => {
    const fx = makeFx();
    const run = await makeRun(fx, { dismissedAt: null });
    assert.ok((await listRuns(db)).some((r) => r.id === run.id));

    const dismissed = await dismissRun(db, run.id, NOW);
    assert.equal(dismissed.dismissedAt, NOW.toISOString());
    assert.ok(!(await listRuns(db)).some((r) => r.id === run.id));
    assert.ok((await listRuns(db, { includeDismissed: true })).some((r) => r.id === run.id));

    const restored = await undismissRun(db, run.id);
    assert.equal(restored.dismissedAt, null);
    assert.ok((await listRuns(db)).some((r) => r.id === run.id));
  });

  it("refuses a running run (409)", async () => {
    const fx = makeFx();
    const run = await makeRun(fx, { status: "running", dismissedAt: null });
    await assert.rejects(dismissRun(db, run.id), (e: unknown) => e instanceof DismissError && e.code === "conflict");
    assert.equal(row(run.id).dismissedAt, null);
  });

  it("refuses while an approval is open, and while a resume intent is queued", async () => {
    const fx = makeFx();
    const run = await makeRun(fx, { dismissedAt: null });
    addApproval(run.id, "merge", "pending");
    await assert.rejects(dismissRun(db, run.id), (e: unknown) => e instanceof DismissError && e.code === "conflict");

    db.update(agentRunApprovals).set({ status: "done" }).where(eq(agentRunApprovals.runId, run.id)).run();
    db.insert(agentRunIntents).values({ id: `int-${++counter}`, runId: run.id, kind: "resume", payload: "{}" }).run();
    await assert.rejects(dismissRun(db, run.id), (e: unknown) => e instanceof DismissError && e.code === "conflict");

    db.delete(agentRunIntents).where(eq(agentRunIntents.runId, run.id)).run();
    assert.equal((await dismissRun(db, run.id, NOW)).dismissedAt, NOW.toISOString());
  });

  it("reports an unknown run as not_found", async () => {
    await assert.rejects(dismissRun(db, "run-nope"), (e: unknown) => e instanceof DismissError && e.code === "not_found");
  });
});

describe("retention setting", () => {
  it("defaults to off, accepts 1-365, rejects the rest", async () => {
    const store = new Map<string, string>();
    const opts = {
      store: {
        get: (k: string) => store.get(k) ?? null,
        set: (k: string, v: string) => {
          if (v.trim() === "") store.delete(k);
          else store.set(k, v);
        },
      },
    };
    assert.equal(await getRetentionDays(opts), null);
    assert.deepEqual(await setRetentionDays(30, opts), { ok: true });
    assert.equal(await getRetentionDays(opts), 30);
    for (const bad of [0, 366, 1.5, -3]) assert.equal((await setRetentionDays(bad, opts)).ok, false);
    assert.equal(await getRetentionDays(opts), 30);
    assert.deepEqual(await setRetentionDays(null, opts), { ok: true });
    assert.equal(await getRetentionDays(opts), null);
  });
});

describe("retention", () => {
  it("does nothing when the setting is off", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    git(fx.repo, "merge", run.branch);
    assert.deepEqual(await planRetention(db, NOW, fx.deps(null)), []);
    const result = await applyRetention([], { db, ...fx.deps(null), now: () => NOW });
    assert.deepEqual(result, { removed: [], skipped: [] });
    assert.ok(fs.existsSync(run.worktree));
  });

  it("does nothing for a run that is not old enough", async () => {
    const fx = makeFx();
    const run = await makeRun(fx, { dismissedAt: RECENT });
    const plan = await planRetention(db, NOW, fx.deps(7));
    assert.ok(!plan.some((c) => c.runId === run.id));
    assert.ok(fs.existsSync(run.worktree));
  });

  it("does nothing for a run that is not dismissed", async () => {
    const fx = makeFx();
    const run = await makeRun(fx, { dismissedAt: null });
    git(fx.repo, "merge", run.branch);
    const plan = await planRetention(db, NOW, fx.deps(7));
    assert.ok(!plan.some((c) => c.runId === run.id));
    assert.ok(fs.existsSync(run.worktree));
  });

  it("removes the worktree and deletes the branch when it is merged", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    git(fx.repo, "merge", run.branch);
    const plan = await planRetention(db, NOW, fx.deps(7));
    const entry = plan.find((c) => c.runId === run.id);
    assert.equal(entry?.action, "remove_worktree", entry?.reason);
    assert.equal(entry?.branch, run.branch);

    const result = await applyRetention(plan, { db, ...fx.deps(7), now: () => NOW });
    assert.equal(result.removed.length, 1, JSON.stringify(result));
    assert.ok(!fs.existsSync(run.worktree));
    assert.ok(!branchExists(fx.repo, run.branch));
    assert.equal(row(run.id).workspacePath, null);
    assert.ok(fs.existsSync(path.join(fx.repo, "feature.txt")), "the merged work stays in the repo");
    const events = db.select().from(agentRunEvents).where(eq(agentRunEvents.runId, run.id)).all();
    assert.ok(events.some((e) => e.payload.includes("Cleanup")));
    // A second pass has nothing left to do.
    assert.ok(!(await planRetention(db, NOW, fx.deps(7))).some((c) => c.runId === run.id));
  });

  it("skips a branch with unmerged commits and keeps the branch and worktree", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    const plan = await planRetention(db, NOW, fx.deps(7));
    const entry = plan.find((c) => c.runId === run.id);
    assert.equal(entry?.action, "skip");
    assert.match(entry?.reason ?? "", /commit/);
    const result = await applyRetention(plan, { db, ...fx.deps(7), now: () => NOW });
    assert.equal(result.removed.length, 0);
    assert.ok(fs.existsSync(run.worktree));
    assert.ok(branchExists(fx.repo, run.branch));
    assert.equal(row(run.id).workspacePath, run.worktree);
  });

  it("skips a worktree with uncommitted or untracked changes", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    git(fx.repo, "merge", run.branch);
    fs.writeFileSync(path.join(run.worktree, "scratch.txt"), "unsaved\n");
    const plan = await planRetention(db, NOW, fx.deps(7));
    const entry = plan.find((c) => c.runId === run.id);
    assert.equal(entry?.action, "skip");
    assert.match(entry?.reason ?? "", /uncommitted|untracked/);
    const result = await applyRetention(plan, { db, ...fx.deps(7), now: () => NOW });
    assert.equal(result.removed.length, 0);
    assert.ok(fs.existsSync(path.join(run.worktree, "scratch.txt")));
    assert.ok(branchExists(fx.repo, run.branch));
  });

  it("refuses a recorded path outside command-center and touches nothing", async () => {
    const fx = makeFx();
    const outside = path.join(fx.root, "somewhere else");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "keep.txt"), "mine\n");
    const id = `run-ret-${++counter}`;
    db.insert(agentRuns)
      .values({
        id,
        projectId: fx.projectId,
        status: "succeeded",
        request: "{}",
        workspaceKind: "git_worktree",
        workspacePath: outside,
        branch: "agent/abcdefabcdef",
        dismissedAt: OLD,
      })
      .run();
    // The snap folder itself is not a run worktree either.
    const snapDir = path.join(fx.worktreeRoot, "command-center", "snap");
    fs.mkdirSync(snapDir, { recursive: true });
    const id2 = `run-ret-${++counter}`;
    db.insert(agentRuns)
      .values({
        id: id2,
        projectId: fx.projectId,
        status: "failed",
        request: "{}",
        workspaceKind: "git_worktree",
        workspacePath: snapDir,
        branch: "agent/abcdefabcdef",
        dismissedAt: OLD,
      })
      .run();

    const plan = await planRetention(db, NOW, fx.deps(7));
    for (const rid of [id, id2]) {
      const entry = plan.find((c) => c.runId === rid);
      assert.equal(entry?.action, "skip");
      assert.match(entry?.reason ?? "", /not inside/);
    }
    const result = await applyRetention(plan, { db, ...fx.deps(7), now: () => NOW });
    assert.equal(result.removed.length, 0);
    assert.ok(fs.existsSync(path.join(outside, "keep.txt")));
    assert.ok(fs.existsSync(snapDir));
  });

  it("removes a snapshot run's worktree and snap folder, never the original folder", async () => {
    const fx = makeFx({ git: false });
    const run = await makeRun(fx);
    assert.equal(row(run.id).workspaceKind, "snapshot_copy");
    const snapRoot = path.join(fx.worktreeRoot, "command-center", "snap");
    assert.equal(fs.readdirSync(snapRoot).length, 1);
    const original = fs.readdirSync(fx.repo).sort();

    const plan = await planRetention(db, NOW, fx.deps(7));
    const entry = plan.find((c) => c.runId === run.id);
    assert.equal(entry?.action, "remove_worktree", entry?.reason);
    const result = await applyRetention(plan, { db, ...fx.deps(7), now: () => NOW });
    assert.equal(result.removed.length, 1, JSON.stringify(result));
    assert.ok(!fs.existsSync(run.worktree));
    assert.equal(fs.readdirSync(snapRoot).length, 0, "the run's snap folder is gone");
    assert.deepEqual(fs.readdirSync(fx.repo).sort(), original, "the original folder is untouched");
    assert.equal(row(run.id).workspacePath, null);
  });

  it("skips a snapshot run with an open apply_back approval", async () => {
    const fx = makeFx({ git: false });
    const run = await makeRun(fx);
    addApproval(run.id, "apply_back", "approved");
    const plan = await planRetention(db, NOW, fx.deps(7));
    const entry = plan.find((c) => c.runId === run.id);
    assert.equal(entry?.action, "skip");
    assert.match(entry?.reason ?? "", /approval/);
    const result = await applyRetention(plan, { db, ...fx.deps(7), now: () => NOW });
    assert.equal(result.removed.length, 0);
    assert.ok(fs.existsSync(run.worktree));
  });

  it("applyRetention re-checks: a worktree that turned dirty after the plan is kept", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    git(fx.repo, "merge", run.branch);
    const plan = await planRetention(db, NOW, fx.deps(7));
    assert.equal(plan.find((c) => c.runId === run.id)?.action, "remove_worktree");
    fs.writeFileSync(path.join(run.worktree, "late.txt"), "late\n");
    const result = await applyRetention(plan, { db, ...fx.deps(7), now: () => NOW });
    assert.equal(result.removed.length, 0);
    assert.ok(fs.existsSync(path.join(run.worktree, "late.txt")));
  });
});

describe("runner cleanup pass", () => {
  it("removes what is due, logs a summary, and the runner starts and stops cleanly", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    git(fx.repo, "merge", run.branch);
    const lines: string[] = [];
    const log: LogFn = (_level, msg) => {
      lines.push(msg);
    };
    const outcome = await runRetentionPass(db, log, fx.deps(7), NOW);
    assert.equal(outcome.removed, 1);
    assert.ok(lines.some((l) => /removed 1, skipped [0-9]+/.test(l)));

    const runner = createRunner({ db, log, retention: fx.deps(null), pollIntervalMs: 20, retentionIntervalMs: 50 });
    await runner.start();
    await runner.shutdown(100);
  });
});

/**
 * Approvals core (AW4-08): preview -> approve -> the runner executes -> logged.
 *
 * Real temp git repos (folders with spaces), a local bare repo as the "remote",
 * and a fake GitHub dependency: no network.
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
import {
  ApprovalError,
  APPROVAL_KINDS,
  decideApproval,
  executeApproval,
  getApproval,
  listApprovals,
  requestApproval,
  type ApprovalEnv,
  type ApprovalKind,
} from "../../src/core/agents/approvals";
import { fakeAdapter } from "../../src/core/agents/adapters/fake";
import { readSince } from "../../src/core/agents/events";
import type { DraftPrInput } from "../../src/core/agents/github-pr";
import { buildPrBody } from "../../src/core/agents/pr-body";
import { acquireWorkspaceLock } from "../../src/core/agents/roots";
import { createRunWorkspace } from "../../src/core/agents/snapshot";
import { createRunner, type LogFn } from "../../runner/index";

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

const silent: LogFn = () => {};

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.local", "-c", "core.autocrlf=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

interface Fx {
  root: string;
  workspaceRoot: string;
  repo: string;
  worktreeRoot: string;
  runStore: string;
  projectId: string;
  env: ApprovalEnv;
}

function makeFx(opts: { git?: boolean } = {}): Fx {
  const n = ++counter;
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "approvals test ")));
  tempDirs.push(root);
  const workspaceRoot = path.join(root, "work spaces");
  const repo = path.join(workspaceRoot, "my repo");
  const worktreeRoot = path.join(root, "work trees");
  const runStore = path.join(root, "run store");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(worktreeRoot, { recursive: true });
  fs.mkdirSync(runStore, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# hi\n");
  if (opts.git !== false) {
    git(repo, "init", "-b", "main");
    git(repo, "config", "core.autocrlf", "false");
    // The merge uses the repo owner identity, as in a real checkout (CI has no global identity).
    git(repo, "config", "user.name", "Test Owner");
    git(repo, "config", "user.email", "owner@example.local");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "initial");
  }
  const projectId = `prj-appr-${n}`;
  db.insert(projects).values({ id: projectId, name: `Appr ${n}`, localPath: repo }).run();
  return { root, workspaceRoot, repo, worktreeRoot, runStore, projectId, env: { repoPath: repo, worktreeRoot, runStore } };
}

const OUTCOME = {
  status: "succeeded",
  facts: {
    implementerExitCode: 0,
    diffFiles: 1,
    excludedTouched: [],
    checks: [{ name: "ok", exitCode: 0, timedOut: false }],
    reviewVerdict: "approve",
  },
  missing: [],
};

/** A finished run with a real workspace and one committed change. */
async function makeRun(
  fx: Fx,
  extra: Partial<typeof agentRuns.$inferInsert> = {},
): Promise<{ id: string; worktree: string; branch: string }> {
  const id = `run-appr-${++counter}`;
  const ws = await createRunWorkspace({ repoPath: fx.repo, worktreeRoot: fx.worktreeRoot, runId: id });
  fs.writeFileSync(path.join(ws.path, "feature.txt"), "feature\n");
  git(ws.path, "add", "-A");
  git(ws.path, "commit", "-m", "agent: add feature");
  const request = {
    projectId: fx.projectId,
    task: "add a file\nwith details",
    roles: { implementer: { provider: "fake", model: "success" } },
    checks: [],
  };
  db.insert(agentRuns)
    .values({
      id,
      projectId: fx.projectId,
      status: "succeeded",
      stage: "final",
      request: JSON.stringify(request),
      workspaceKind: ws.kind,
      workspacePath: ws.path,
      baseRef: ws.baseSha,
      branch: ws.branch,
      outcome: JSON.stringify(OUTCOME),
      ...extra,
    })
    .run();
  return { id, worktree: ws.path, branch: ws.branch };
}

function bareRemote(fx: Fx, repoPath: string, urlDir = "remote.git"): string {
  const bare = path.join(fx.root, ...urlDir.split("/"));
  fs.mkdirSync(bare, { recursive: true });
  git(bare, "init", "--bare", "-b", "main");
  git(repoPath, "remote", "add", "origin", bare.replace(/\\/g, "/"));
  return bare;
}

const lockCount = (runId: string) =>
  db.select().from(agentWorkspaceLocks).where(eq(agentWorkspaceLocks.runId, runId)).all().length;
const intentsOf = (runId: string) => db.select().from(agentRunIntents).where(eq(agentRunIntents.runId, runId)).all();
const phases = async (runId: string) =>
  (await readSince(db, runId, 0, 1000)).filter((e) => e.kind === "approval").map((e) => (e.payload as { phase: string }).phase);

async function approve(id: string): Promise<void> {
  await decideApproval(db, id, "approve");
}

const isErr = (code: string) => (e: unknown) => e instanceof ApprovalError && e.code === code;

describe("requesting", () => {
  it("only finished runs can have approvals", async () => {
    const fx = makeFx();
    const run = await makeRun(fx, { status: "running" });
    await assert.rejects(requestApproval(db, run.id, "push", {}, fx.env), isErr("conflict"));
    await assert.rejects(requestApproval(db, "run-missing", "push", {}, fx.env), isErr("not_found"));
  });

  it("rejects a bad target with an invalid error", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    for (const [kind, target] of [
      ["merge", {}],
      ["merge", { targetBranch: "--force" }],
      ["push", { remote: "a b" }],
      ["draft_pr", { base: "main", extra: 1 }],
    ] as const) {
      await assert.rejects(requestApproval(db, run.id, kind, target, fx.env), isErr("invalid"), `${kind} ${JSON.stringify(target)}`);
    }
  });

  it("one pending approval per run and kind", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    const first = await requestApproval(db, run.id, "merge", { targetBranch: "main" }, fx.env);
    assert.equal(first.status, "pending");
    await assert.rejects(requestApproval(db, run.id, "merge", { targetBranch: "main" }, fx.env), isErr("conflict"));
    // another kind is fine
    const wt = await requestApproval(db, run.id, "delete_worktree", {}, fx.env);
    assert.equal(wt.status, "pending");
    // once decided against, a new request is allowed
    await decideApproval(db, first.id, "reject");
    const again = await requestApproval(db, run.id, "merge", { targetBranch: "main" }, fx.env);
    assert.equal(again.status, "pending");
    assert.equal(listApprovals(db, run.id).length, 3);
  });

  it("apply_back is refused for a git_worktree run", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    await assert.rejects(
      requestApproval(db, run.id, "apply_back", {}, fx.env),
      (e: unknown) => e instanceof ApprovalError && e.code === "invalid" && /copy of a folder/.test(e.message),
    );
    assert.equal(listApprovals(db, run.id).length, 0);
  });

  it("git-only kinds are refused for a snapshot run", async () => {
    const fx = makeFx({ git: false });
    const run = await makeRun(fx);
    assert.equal(db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).get()?.workspaceKind, "snapshot_copy");
    for (const kind of ["merge", "push", "draft_pr"] as const) {
      await assert.rejects(requestApproval(db, run.id, kind, { targetBranch: "main", base: "main" }, fx.env), isErr("invalid"), kind);
    }
  });

  it("the merge preview lists commits, conflicts and the dirty state", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    const a = await requestApproval(db, run.id, "merge", { targetBranch: "main" }, fx.env);
    assert.equal(a.preview.commitsAhead, 1);
    assert.equal(a.preview.conflicts, false);
    assert.equal(a.preview.dirty, false);
    assert.equal(a.preview.targetSha, git(fx.repo, "rev-parse", "main"));
    assert.equal(a.preview.runSha, git(fx.repo, "rev-parse", run.branch));
    // not the checked-out branch: refused, the app never switches the checkout
    git(fx.repo, "branch", "other");
    const run2 = await makeRun(fx);
    await assert.rejects(
      requestApproval(db, run2.id, "merge", { targetBranch: "other" }, fx.env),
      (e: unknown) => e instanceof ApprovalError && /checked out/.test(e.message),
    );
    // a remote that does not exist
    await assert.rejects(requestApproval(db, run2.id, "push", { remote: "nope" }, fx.env), isErr("invalid"));
  });
});

describe("approval gate", () => {
  it("every kind is refused until approved, and nothing changes", async () => {
    const gitFx = makeFx();
    const gitRun = await makeRun(gitFx);
    bareRemote(gitFx, gitFx.repo, "github.com/acme/widgets.git");
    git(gitFx.repo, "push", "origin", gitRun.branch);
    const snapFx = makeFx({ git: false });
    const snapRun = await makeRun(snapFx);
    fs.writeFileSync(path.join(snapRun.worktree, "README.md"), "# changed\n");
    git(snapRun.worktree, "add", "-A");
    git(snapRun.worktree, "commit", "-m", "edit");
    const mainBefore = git(gitFx.repo, "rev-parse", "main");

    const cases: Array<[ApprovalKind, Fx, { id: string }, unknown]> = [
      ["merge", gitFx, gitRun, { targetBranch: "main" }],
      ["push", gitFx, gitRun, {}],
      ["draft_pr", gitFx, gitRun, { base: "main" }],
      ["delete_worktree", gitFx, gitRun, {}],
      ["apply_back", snapFx, snapRun, {}],
    ];
    assert.deepEqual(cases.map((c) => c[0]).sort(), [...APPROVAL_KINDS].sort());
    for (const [kind, fx, run, target] of cases) {
      const a = await requestApproval(db, run.id, kind, target, fx.env);
      assert.equal(a.status, "pending");
      await assert.rejects(
        executeApproval(db, a.id, fx.env, {
          createDraftPr: async () => {
            throw new Error("must not be called");
          },
        }),
        isErr("refused"),
        kind,
      );
      assert.equal(getApproval(db, a.id)?.status, "pending", kind);
    }
    assert.equal(git(gitFx.repo, "rev-parse", "main"), mainBefore);
    assert.ok(fs.existsSync(gitRun.worktree));
    assert.equal(fs.readFileSync(path.join(snapFx.repo, "README.md"), "utf8"), "# hi\n");
    assert.equal(lockCount(gitRun.id), 0);
  });

  it("the reject path ends the approval and queues nothing", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    const a = await requestApproval(db, run.id, "delete_worktree", {}, fx.env);
    const rejected = await decideApproval(db, a.id, "reject");
    assert.equal(rejected.status, "rejected");
    assert.ok(rejected.decidedAt);
    assert.equal(intentsOf(run.id).length, 0);
    await assert.rejects(decideApproval(db, a.id, "approve"), isErr("conflict"));
    await assert.rejects(executeApproval(db, a.id, fx.env), isErr("refused"));
    assert.ok(fs.existsSync(run.worktree));
    assert.deepEqual(await phases(run.id), ["requested", "rejected"]);
  });

  it("approving only queues an approval_execute intent", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    const a = await requestApproval(db, run.id, "merge", { targetBranch: "main" }, fx.env);
    const mainBefore = git(fx.repo, "rev-parse", "main");
    const approved = await decideApproval(db, a.id, "approve");
    assert.equal(approved.status, "approved");
    const intents = intentsOf(run.id);
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.kind, "approval_execute");
    assert.deepEqual(JSON.parse(intents[0]?.payload ?? "{}"), { approvalId: a.id });
    assert.equal(git(fx.repo, "rev-parse", "main"), mainBefore, "nothing ran in decide()");
    await assert.rejects(decideApproval(db, a.id, "approve"), isErr("conflict"));
  });
});

describe("merge", () => {
  it("takes the repo lock for the merge and releases it", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    const a = await requestApproval(db, run.id, "merge", { targetBranch: "main" }, fx.env);
    await approve(a.id);
    let lockedDuring = -1;
    const done = await executeApproval(db, a.id, fx.env, {
      afterLock: () => {
        lockedDuring = lockCount(run.id);
      },
    });
    assert.equal(done.status, "done", done.error ?? "");
    assert.equal(lockedDuring, 1);
    assert.equal(lockCount(run.id), 0);
    assert.ok(fs.existsSync(path.join(fx.repo, "feature.txt")));
    assert.equal(git(fx.repo, "rev-parse", "main"), (done.result as { mergeSha: string }).mergeSha);
    assert.equal(git(fx.repo, "rev-list", "--parents", "-n", "1", "main").split(" ").length, 3, "a merge commit");
    assert.deepEqual(await phases(run.id), ["requested", "approved", "executing", "done"]);
  });

  it("is refused while another run holds the lock, and the lock is not stolen", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    const other = await makeRun(fx);
    const held = acquireWorkspaceLock(db, other.id, fx.repo);
    assert.ok(held.ok);
    const a = await requestApproval(db, run.id, "merge", { targetBranch: "main" }, fx.env);
    await approve(a.id);
    const done = await executeApproval(db, a.id, fx.env);
    assert.equal(done.status, "failed");
    assert.match(done.error ?? "", /lock/);
    assert.equal(lockCount(other.id), 1);
    db.delete(agentWorkspaceLocks).where(eq(agentWorkspaceLocks.runId, other.id)).run();
  });

  it("is refused on a dirty checkout", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    const a = await requestApproval(db, run.id, "merge", { targetBranch: "main" }, fx.env);
    await approve(a.id);
    fs.writeFileSync(path.join(fx.repo, "README.md"), "# edited by hand\n");
    const mainBefore = git(fx.repo, "rev-parse", "main");
    const done = await executeApproval(db, a.id, fx.env);
    assert.equal(done.status, "failed");
    assert.match(done.error ?? "", /uncommitted/);
    assert.equal(git(fx.repo, "rev-parse", "main"), mainBefore);
    assert.equal(fs.readFileSync(path.join(fx.repo, "README.md"), "utf8"), "# edited by hand\n");
    assert.equal(lockCount(run.id), 0);
    assert.ok((await phases(run.id)).includes("failed"));
  });

  it("fails when the run branch moved since the preview", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    const a = await requestApproval(db, run.id, "merge", { targetBranch: "main" }, fx.env);
    await approve(a.id);
    fs.writeFileSync(path.join(run.worktree, "more.txt"), "more\n");
    git(run.worktree, "add", "-A");
    git(run.worktree, "commit", "-m", "agent: more");
    const mainBefore = git(fx.repo, "rev-parse", "main");
    const done = await executeApproval(db, a.id, fx.env);
    assert.equal(done.status, "failed");
    assert.match(done.error ?? "", /moved since the preview.*new preview/);
    assert.equal(git(fx.repo, "rev-parse", "main"), mainBefore);
  });

  it("fails when the target branch moved since the preview", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    const a = await requestApproval(db, run.id, "merge", { targetBranch: "main" }, fx.env);
    await approve(a.id);
    fs.writeFileSync(path.join(fx.repo, "elsewhere.txt"), "x\n");
    git(fx.repo, "add", "-A");
    git(fx.repo, "commit", "-m", "someone else");
    const done = await executeApproval(db, a.id, fx.env);
    assert.equal(done.status, "failed");
    assert.match(done.error ?? "", /moved since the preview/);
  });

  it("aborts a conflicting merge and leaves the checkout clean", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    fs.writeFileSync(path.join(run.worktree, "README.md"), "# agent version\n");
    git(run.worktree, "add", "-A");
    git(run.worktree, "commit", "-m", "agent readme");
    fs.writeFileSync(path.join(fx.repo, "README.md"), "# main version\n");
    git(fx.repo, "add", "-A");
    git(fx.repo, "commit", "-m", "main readme");
    const a = await requestApproval(db, run.id, "merge", { targetBranch: "main" }, fx.env);
    assert.equal(a.preview.conflicts, true);
    await approve(a.id);
    const done = await executeApproval(db, a.id, fx.env);
    assert.equal(done.status, "failed");
    assert.equal(git(fx.repo, "status", "--porcelain"), "");
    assert.equal(fs.readFileSync(path.join(fx.repo, "README.md"), "utf8"), "# main version\n");
  });
});

describe("push", () => {
  it("pushes the run branch to the remote without force", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    const bare = bareRemote(fx, fx.repo);
    const a = await requestApproval(db, run.id, "push", {}, fx.env);
    assert.equal(a.preview.remote, "origin");
    assert.equal(a.preview.force, false);
    assert.equal(a.preview.commitsAhead, 1);
    await approve(a.id);
    const done = await executeApproval(db, a.id, fx.env);
    assert.equal(done.status, "done", done.error ?? "");
    assert.equal(git(bare, "rev-parse", run.branch), git(fx.repo, "rev-parse", run.branch));
  });

  it("does not overwrite a diverged remote branch", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    const bare = bareRemote(fx, fx.repo);
    // the remote already has this branch name at an unrelated commit
    const other = path.join(fx.root, "other clone");
    git(fx.root, "clone", bare, other);
    git(other, "checkout", "-b", run.branch);
    fs.writeFileSync(path.join(other, "theirs.txt"), "theirs\n");
    git(other, "add", "-A");
    git(other, "commit", "-m", "theirs");
    git(other, "push", "origin", run.branch);
    const theirs = git(bare, "rev-parse", run.branch);
    const a = await requestApproval(db, run.id, "push", {}, fx.env);
    await approve(a.id);
    const done = await executeApproval(db, a.id, fx.env);
    assert.equal(done.status, "failed");
    assert.equal(git(bare, "rev-parse", run.branch), theirs);
  });
});

describe("draft_pr", () => {
  it("opens a draft PR whose body is buildPrBody of the recorded facts", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    bareRemote(fx, fx.repo, "github.com/acme/widgets.git");
    const a = await requestApproval(db, run.id, "draft_pr", { base: "main" }, fx.env);
    const expected = buildPrBody({
      title: "add a file",
      implementer: "fake (success)",
      reviewer: null,
      outcome: OUTCOME as never,
      changedFiles: ["feature.txt"],
      agentSummary: null,
    });
    assert.equal(a.preview.body, expected);
    assert.equal(a.preview.title, "add a file");
    assert.equal(a.preview.owner, "acme");
    assert.equal(a.preview.repo, "widgets");
    assert.equal(a.preview.draft, true);

    await approve(a.id);
    // the branch is not on the remote yet: refused until pushed
    const notPushed = await executeApproval(db, a.id, fx.env, { createDraftPr: async () => ({ url: "x", number: 1 }) });
    assert.equal(notPushed.status, "failed");
    assert.match(notPushed.error ?? "", /push/);

    // a fresh request after pushing
    git(fx.repo, "push", "origin", run.branch);
    const b = await requestApproval(db, run.id, "draft_pr", { base: "main" }, fx.env);
    await approve(b.id);
    const calls: DraftPrInput[] = [];
    const done = await executeApproval(db, b.id, fx.env, {
      createDraftPr: async (input) => {
        calls.push(input);
        return { url: "https://github.com/acme/widgets/pull/7", number: 7 };
      },
    });
    assert.equal(done.status, "done", done.error ?? "");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.body, expected);
    assert.equal(calls[0]?.head, run.branch);
    assert.equal(calls[0]?.base, "main");
    assert.deepEqual(done.result, {
      url: "https://github.com/acme/widgets/pull/7",
      number: 7,
      draft: true,
      runSha: git(fx.repo, "rev-parse", run.branch),
    });
  });

  it("the GitHub call always sends draft: true", async () => {
    const { createGitHubDraftPr } = await import("../../src/core/agents/github-pr");
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const create = createGitHubDraftPr({
      getToken: async () => "token-123",
      fetchFn: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ html_url: "https://github.com/acme/widgets/pull/9", number: 9 }), { status: 201 });
      }) as unknown as typeof fetch,
    });
    const pr = await create({ owner: "acme", repo: "widgets", head: "agent/abc", base: "main", title: "t", body: "b" });
    assert.deepEqual(pr, { url: "https://github.com/acme/widgets/pull/9", number: 9 });
    assert.equal(seen[0]?.url, "https://api.github.com/repos/acme/widgets/pulls");
    assert.equal(JSON.parse(String(seen[0]?.init.body)).draft, true);
    const input = { owner: "acme", repo: "widgets", head: "h", base: "main", title: "t", body: "b" };
    await assert.rejects(
      createGitHubDraftPr({ getToken: async () => null, fetchFn: (async () => new Response("{}")) as unknown as typeof fetch })(input),
      /not connected/,
    );
    await assert.rejects(create({ ...input, owner: "../x" }), /not valid/);
  });
});

describe("apply_back", () => {
  it("previews the plan and applies it with a backup under the run store", async () => {
    const fx = makeFx({ git: false });
    const run = await makeRun(fx);
    const a = await requestApproval(db, run.id, "apply_back", {}, fx.env);
    assert.equal(a.preview.writes, 1);
    await approve(a.id);
    let locked = 0;
    const done = await executeApproval(db, a.id, fx.env, {
      afterLock: () => {
        locked = lockCount(run.id);
      },
    });
    assert.equal(done.status, "done", done.error ?? "");
    assert.equal(locked, 1);
    assert.equal(lockCount(run.id), 0);
    assert.equal(fs.readFileSync(path.join(fx.repo, "feature.txt"), "utf8"), "feature\n");
    const backupDir = (done.result as { backupDir: string | null }).backupDir;
    if (backupDir) assert.ok(backupDir.startsWith(fx.runStore));
  });
});

describe("delete_worktree", () => {
  it("lists unmerged commits, removes the worktree and keeps the branch", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    const a = await requestApproval(db, run.id, "delete_worktree", {}, fx.env);
    const commits = a.preview.unmergedCommits as Array<{ subject: string }>;
    assert.equal(commits.length, 1);
    assert.equal(commits[0]?.subject, "agent: add feature");
    await approve(a.id);
    const done = await executeApproval(db, a.id, fx.env);
    assert.equal(done.status, "done", done.error ?? "");
    assert.ok(!fs.existsSync(run.worktree));
    assert.ok(git(fx.repo, "branch", "--list", run.branch).includes(run.branch));
  });
});

describe("execution only through the runner", () => {
  function runnerFor(fx: Fx, workspaceRoot = fx.workspaceRoot) {
    return createRunner({
      db,
      epoch: "epoch-approvals",
      log: silent,
      implementer: fakeAdapter,
      getStorage: async () => ({ workspaceRoots: [workspaceRoot], worktreeRoot: fx.worktreeRoot, runStore: fx.runStore }),
    });
  }

  it("the runner claims the approval_execute intent and runs the approval", async () => {
    db.delete(agentRunIntents).run();
    const fx = makeFx();
    const run = await makeRun(fx);
    const a = await requestApproval(db, run.id, "merge", { targetBranch: "main" }, fx.env);
    const mainBefore = git(fx.repo, "rev-parse", "main");
    await approve(a.id);
    assert.equal(git(fx.repo, "rev-parse", "main"), mainBefore);
    const runner = runnerFor(fx);
    assert.equal(await runner.tick(), true);
    assert.equal(getApproval(db, a.id)?.status, "done");
    assert.notEqual(git(fx.repo, "rev-parse", "main"), mainBefore);
    assert.equal(await runner.tick(), false);
  });

  it("marks the approval failed when the project path is refused", async () => {
    db.delete(agentRunIntents).run();
    const fx = makeFx();
    const run = await makeRun(fx);
    const a = await requestApproval(db, run.id, "delete_worktree", {}, fx.env);
    await approve(a.id);
    const runner = runnerFor(fx, path.join(fx.root, "not the root"));
    await runner.tick();
    const row = getApproval(db, a.id);
    assert.equal(row?.status, "failed");
    assert.match(row?.error ?? "", /refused/i);
    assert.ok(fs.existsSync(run.worktree));
  });

  it("a second execution of the same approval does nothing", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    const a = await requestApproval(db, run.id, "delete_worktree", {}, fx.env);
    await approve(a.id);
    assert.equal((await executeApproval(db, a.id, fx.env)).status, "done");
    await assert.rejects(executeApproval(db, a.id, fx.env), isErr("refused"));
  });
});

describe("table", () => {
  it("cascades with the run", async () => {
    const fx = makeFx();
    const run = await makeRun(fx);
    const a = await requestApproval(db, run.id, "delete_worktree", {}, fx.env);
    db.delete(agentRuns).where(eq(agentRuns.id, run.id)).run();
    assert.equal(db.select().from(agentRunApprovals).where(eq(agentRunApprovals.id, a.id)).all().length, 0);
  });
});

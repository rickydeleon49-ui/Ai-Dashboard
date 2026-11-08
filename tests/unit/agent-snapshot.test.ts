/**
 * Unit tests for non-Git project snapshots and apply-back (AW4-06).
 * Real temp directories (with spaces in their names), cleaned up afterwards.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  applyBack,
  createRunWorkspace,
  createSnapshot,
  hashFile,
  planApplyBack,
  resolveInside,
} from "../../src/core/agents/snapshot";
import { commitStage, createRunWorktree, execGit, shortRunId } from "../../src/core/agents/workspace";

let tmpDir: string;
let counter = 0;

function fresh(name: string): string {
  counter += 1;
  const dir = path.join(tmpDir, `${name} ${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function put(root: string, rel: string, content: string | Buffer): void {
  const file = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, ...rel.split("/")), "utf8");
}

function exists(root: string, rel: string): boolean {
  return fs.existsSync(path.join(root, ...rel.split("/")));
}

function buildProject(): string {
  const dir = fresh("project");
  put(dir, "README.md", "# Project\r\n");
  put(dir, "src/main.txt", "main v1\n");
  put(dir, "src/old.txt", "old\n");
  put(dir, "src/keep.txt", "keep\n");
  put(dir, "docs/guide.md", "guide\n");
  put(dir, "secrets/key.pem", "SECRET\n");
  put(dir, ".env", "TOKEN=1\n");
  put(dir, "node_modules/dep/index.js", "x\n");
  put(dir, "build/out.js", "x\n");
  put(dir, ".venv/pyvenv.cfg", "x\n");
  put(dir, "pkg/__pycache__/a.pyc", "x\n");
  put(dir, ".DS_Store", "x\n");
  put(dir, ".gitignore", "src/keep.txt\n");
  return dir;
}

const RUN_ID = "11111111-2222-3333-4444-555555555555";

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw4-06 snapshot "));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("createSnapshot", () => {
  it("copies the project honouring exclusions, heavy folders and symlinks", async () => {
    const source = buildProject();
    const outside = fresh("outside");
    put(outside, "leak.txt", "leak\n");
    let linked = false;
    try {
      fs.symlinkSync(outside, path.join(source, "link-dir"), "junction");
      linked = true;
    } catch {
      // no link support on this machine: the rest of the test still runs
    }
    const worktreeRoot = fresh("wt");
    const snap = await createSnapshot({
      sourceDir: source,
      worktreeRoot,
      runId: RUN_ID,
      excludedPaths: ["secrets/**", ".env"],
    });

    assert.equal(snap.baseRepo, path.join(worktreeRoot, "command-center", "snap", shortRunId(RUN_ID), "base"));
    assert.ok(exists(snap.baseRepo, "README.md"));
    assert.ok(exists(snap.baseRepo, "src/main.txt"));
    assert.ok(exists(snap.baseRepo, "docs/guide.md"));
    // .gitignore'd files are still part of the snapshot
    assert.ok(exists(snap.baseRepo, "src/keep.txt"));
    for (const gone of [
      "secrets/key.pem",
      ".env",
      "node_modules/dep/index.js",
      "build/out.js",
      ".venv/pyvenv.cfg",
      "pkg/__pycache__/a.pyc",
      ".DS_Store",
      "link-dir/leak.txt",
    ]) {
      assert.equal(exists(snap.baseRepo, gone), false, gone);
    }
    assert.ok(snap.skipped.includes("secrets/"));
    assert.ok(snap.skipped.includes(".env"));
    assert.ok(snap.skipped.includes("node_modules/"));
    assert.ok(snap.skipped.includes("pkg/__pycache__/"));
    if (linked) assert.ok(snap.skipped.some((s) => s.startsWith("link-dir")));
    assert.equal(snap.fileCount, 6);
    assert.ok(snap.totalBytes > 0);
    // bytes preserved (CRLF file stays CRLF)
    assert.equal(read(snap.baseRepo, "README.md"), "# Project\r\n");
  });

  it("makes a one-commit repo with a clean status and no global config use", async () => {
    const source = buildProject();
    const worktreeRoot = fresh("wt");
    const snap = await createSnapshot({ sourceDir: source, worktreeRoot, runId: RUN_ID, excludedPaths: [] });
    const count = await execGit(["rev-list", "--count", "HEAD"], { cwd: snap.baseRepo });
    assert.equal(count.stdout.trim(), "1");
    const head = await execGit(["rev-parse", "HEAD"], { cwd: snap.baseRepo });
    assert.equal(head.stdout.trim(), snap.baseSha);
    const status = await execGit(["status", "--porcelain"], { cwd: snap.baseRepo });
    assert.equal(status.stdout.trim(), "");
    const autocrlf = await execGit(["config", "--local", "core.autocrlf"], { cwd: snap.baseRepo });
    assert.equal(autocrlf.stdout.trim(), "false");
  });

  it("refuses a Git source and a source inside the worktree root", async () => {
    const gitSource = fresh("gitsrc");
    await execGit(["init", "-b", "main"], { cwd: gitSource });
    put(gitSource, "a.txt", "a\n");
    await assert.rejects(
      createSnapshot({ sourceDir: gitSource, worktreeRoot: fresh("wt"), runId: RUN_ID, excludedPaths: [] }),
      /Git repository/,
    );

    const worktreeRoot = fresh("wt");
    const inside = path.join(worktreeRoot, "proj");
    put(inside, "a.txt", "a\n");
    await assert.rejects(
      createSnapshot({ sourceDir: inside, worktreeRoot, runId: RUN_ID, excludedPaths: [] }),
      /inside the worktree root/,
    );
  });

  it("refuses when limits are exceeded and removes the partial copy", async () => {
    const source = buildProject();
    const worktreeRoot = fresh("wt");
    await assert.rejects(
      createSnapshot({ sourceDir: source, worktreeRoot, runId: RUN_ID, excludedPaths: [], maxFiles: 2 }),
      /more than 2 files/,
    );
    assert.equal(fs.existsSync(path.join(worktreeRoot, "command-center", "snap", shortRunId(RUN_ID))), false);

    await assert.rejects(
      createSnapshot({ sourceDir: source, worktreeRoot, runId: RUN_ID, excludedPaths: [], maxBytes: 10 }),
      /more than 10 bytes/,
    );
    assert.equal(fs.existsSync(path.join(worktreeRoot, "command-center", "snap", shortRunId(RUN_ID))), false);
  });

  it("createRunWorkspace uses a snapshot worktree for non-Git projects and a plain one for Git", async () => {
    const source = buildProject();
    const worktreeRoot = fresh("wt");
    const ws = await createRunWorkspace({ repoPath: source, worktreeRoot, runId: RUN_ID, excludedPaths: [".env"] });
    assert.equal(ws.kind, "snapshot_copy");
    assert.equal(ws.path, path.join(worktreeRoot, "command-center", shortRunId(RUN_ID)));
    assert.ok(exists(ws.path, "src/main.txt"));
    assert.equal(exists(ws.path, ".env"), false);
    assert.ok(ws.baseRepo);

    const gitRepo = fresh("gitrepo");
    await execGit(["init", "-b", "main"], { cwd: gitRepo });
    put(gitRepo, "a.txt", "a\n");
    await execGit(["add", "-A"], { cwd: gitRepo });
    await execGit(["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-m", "init"], { cwd: gitRepo });
    const gws = await createRunWorkspace({ repoPath: gitRepo, worktreeRoot: fresh("wt"), runId: RUN_ID });
    assert.equal(gws.kind, "git_worktree");
    assert.equal(gws.baseRepo, undefined);
  });
});

describe("apply-back", () => {
  let source: string;
  let worktreeRoot: string;
  let backupRoot: string;
  let runWorktree: string;
  let baseSha: string;
  const EXCLUDED = ["secrets/**", ".env"];

  beforeEach(async () => {
    source = buildProject();
    worktreeRoot = fresh("wt");
    backupRoot = fresh("backups");
    const ws = await createRunWorkspace({ repoPath: source, worktreeRoot, runId: RUN_ID, excludedPaths: EXCLUDED });
    runWorktree = ws.path;
    baseSha = ws.baseSha;
  });

  async function runChanges(): Promise<void> {
    put(runWorktree, "src/main.txt", "main v2\n");
    fs.rmSync(path.join(runWorktree, "src", "old.txt"));
    put(runWorktree, "src/new/added.txt", "added\n");
    fs.renameSync(path.join(runWorktree, "docs", "guide.md"), path.join(runWorktree, "docs", "manual.md"));
    const sha = await commitStage(runWorktree, "implement", shortRunId(RUN_ID));
    assert.ok(sha);
  }

  it("plans write, delete and rename (as delete + write)", async () => {
    await runChanges();
    const plan = await planApplyBack({ runWorktree, baseSha, sourceDir: source, excludedPaths: EXCLUDED });
    const byPath = new Map(plan.map((e) => [e.path, e]));
    assert.equal(plan.length, 5);
    assert.equal(byPath.get("src/main.txt")?.action, "write");
    assert.equal(byPath.get("src/main.txt")?.sourceHashBefore, hashFile(path.join(source, "src", "main.txt")));
    assert.equal(byPath.get("src/main.txt")?.newHash, hashFile(path.join(runWorktree, "src", "main.txt")));
    assert.equal(byPath.get("src/old.txt")?.action, "delete");
    assert.equal(byPath.get("src/old.txt")?.newHash, null);
    assert.equal(byPath.get("src/new/added.txt")?.action, "write");
    assert.equal(byPath.get("src/new/added.txt")?.sourceHashBefore, null);
    assert.equal(byPath.get("docs/guide.md")?.action, "delete");
    assert.equal(byPath.get("docs/manual.md")?.action, "write");
  });

  it("refuses to plan an excluded path", async () => {
    put(runWorktree, "secrets/new.pem", "x\n");
    await execGit(["add", "-A", "-f"], { cwd: runWorktree });
    await execGit(["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-m", "x"], { cwd: runWorktree });
    await assert.rejects(
      planApplyBack({ runWorktree, baseSha, sourceDir: source, excludedPaths: EXCLUDED }),
      /excluded path/,
    );
  });

  it("writes changed files only, backs up originals and writes a manifest", async () => {
    await runChanges();
    const plan = await planApplyBack({ runWorktree, baseSha, sourceDir: source, excludedPaths: EXCLUDED });
    const now = new Date(Date.UTC(2026, 10, 8, 9, 5, 7));
    const result = applyBack(plan, { sourceDir: source, runWorktree, backupRoot, now, excludedPaths: EXCLUDED });

    assert.equal(path.basename(result.backupDir), `20261108-090507-${shortRunId(RUN_ID)}`);
    assert.deepEqual([...result.written].sort(), ["docs/manual.md", "src/main.txt", "src/new/added.txt"]);
    assert.deepEqual([...result.deleted].sort(), ["docs/guide.md", "src/old.txt"]);
    assert.equal(read(source, "src/main.txt"), "main v2\n");
    assert.equal(read(source, "src/new/added.txt"), "added\n");
    assert.equal(exists(source, "src/old.txt"), false);
    assert.equal(exists(source, "docs/guide.md"), false);
    // untouched, including files the snapshot excluded
    assert.equal(read(source, "secrets/key.pem"), "SECRET\n");
    assert.equal(read(source, ".env"), "TOKEN=1\n");
    assert.equal(read(source, "src/keep.txt"), "keep\n");

    // originals of overwritten/deleted files are backed up under the same relative paths
    assert.equal(read(result.backupDir, "src/main.txt"), "main v1\n");
    assert.equal(read(result.backupDir, "src/old.txt"), "old\n");
    assert.equal(read(result.backupDir, "docs/guide.md"), "guide\n");
    assert.equal(exists(result.backupDir, "src/new/added.txt"), false);
    const manifest = JSON.parse(read(result.backupDir, "manifest.json")) as {
      entries: { path: string; action: string }[];
    };
    assert.equal(manifest.entries.length, 5);
    assert.ok(manifest.entries.some((e) => e.path === "src/old.txt" && e.action === "delete"));
  });

  it("refuses the whole apply on a conflict and leaves everything untouched", async () => {
    await runChanges();
    const plan = await planApplyBack({ runWorktree, baseSha, sourceDir: source, excludedPaths: EXCLUDED });
    put(source, "src/old.txt", "edited by the user\n");
    assert.throws(
      () => applyBack(plan, { sourceDir: source, runWorktree, backupRoot, now: new Date() }),
      /Conflict: src\/old\.txt/,
    );
    assert.equal(read(source, "src/main.txt"), "main v1\n");
    assert.equal(read(source, "src/old.txt"), "edited by the user\n");
    assert.equal(read(source, "docs/guide.md"), "guide\n");
    assert.equal(exists(source, "src/new/added.txt"), false);
    assert.deepEqual(fs.readdirSync(backupRoot), []);
  });

  it("restores from the backup when a written file fails hash verification", async () => {
    await runChanges();
    const plan = await planApplyBack({ runWorktree, baseSha, sourceDir: source, excludedPaths: EXCLUDED });
    let calls = 0;
    const faulty = (src: string, dest: string): void => {
      calls += 1;
      if (path.basename(dest) === "main.txt") fs.writeFileSync(dest, "corrupted");
      else fs.copyFileSync(src, dest);
    };
    assert.throws(
      () => applyBack(plan, { sourceDir: source, runWorktree, backupRoot, now: new Date() }, { copyFile: faulty }),
      /Verification failed for src\/main\.txt/,
    );
    assert.ok(calls >= 1);
    assert.equal(read(source, "src/main.txt"), "main v1\n");
    assert.equal(read(source, "src/old.txt"), "old\n");
    assert.equal(read(source, "docs/guide.md"), "guide\n");
    assert.equal(exists(source, "src/new/added.txt"), false);
    assert.equal(exists(source, "src/new"), false);
    assert.equal(exists(source, "docs/manual.md"), false);
  });

  it("rejects .. and absolute paths in a plan", async () => {
    const bad = (p: string) => [{ path: p, action: "write" as const, sourceHashBefore: null, newHash: "a".repeat(40) }];
    const opts = { sourceDir: source, runWorktree, backupRoot, now: new Date() };
    assert.throws(() => applyBack(bad("../escape.txt"), opts), /escapes/);
    assert.throws(() => applyBack(bad("src/../../escape.txt"), opts), /escapes/);
    assert.throws(() => applyBack(bad(path.join(os.tmpdir(), "abs.txt")), opts), /Absolute/);
    assert.throws(() => applyBack(bad("C:\\Windows\\x.txt"), opts), /Absolute/);
    assert.throws(() => applyBack(bad("/etc/passwd"), opts), /Absolute/);
    assert.equal(exists(path.dirname(source), "escape.txt"), false);
  });

  it("rejects a path that goes through a link out of the source folder", () => {
    const outside = fresh("outside");
    try {
      fs.symlinkSync(outside, path.join(source, "linkdir"), "junction");
    } catch {
      return; // no link support here
    }
    assert.throws(() => resolveInside(source, "linkdir/x.txt"), /link/);
  });
});

describe("createRunWorktree stays usable on the snapshot repo", () => {
  it("diffs against the snapshot base like any run", async () => {
    const source = buildProject();
    const worktreeRoot = fresh("wt");
    const snap = await createSnapshot({ sourceDir: source, worktreeRoot, runId: RUN_ID, excludedPaths: [] });
    const wt = await createRunWorktree({ repoPath: snap.baseRepo, worktreeRoot, runId: RUN_ID, baseRef: snap.baseSha });
    assert.equal(wt.baseSha, snap.baseSha);
  });
});

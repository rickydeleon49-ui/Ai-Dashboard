/**
 * Unit tests for agent workspace management, stage commits, and diff summaries
 * (Release AW.1, AW1-05).
 * Real temp git repositories in directories with spaces in their names.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  assertSafeBaseSha,
  commitStage,
  createRunWorktree,
  diffSummary,
  execGit,
  removeRunWorktree,
  shortRunId,
  worktreePathFor,
} from "../../src/core/agents/workspace";

let tmpDir: string;
let repoDir: string;
let worktreeRoot: string;
let baseSha: string;
let outsideDir: string;

/**
 * Initialize a git repository with an initial commit without using global config.
 */
async function initRepoWithCommit(dir: string): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  await execGit(["init", "-b", "main"], { cwd: dir });
  // Do not let a global core.autocrlf leak into the test repos.
  await execGit(["config", "core.autocrlf", "false"], { cwd: dir });

  // Add initial files
  fs.writeFileSync(path.join(dir, "README.md"), "# Initial Workspace\n");
  fs.writeFileSync(
    path.join(dir, "to-delete.txt"),
    "line 1\nline 2\nline 3\nline 4\n",
  );
  fs.writeFileSync(path.join(dir, "to-rename.txt"), "rename target content\n");
  fs.writeFileSync(path.join(dir, "crlf.txt"), "first line\nsecond line\n");

  await execGit(["add", "."], { cwd: dir });
  await execGit(
    [
      "-c",
      "user.name=Test Committer",
      "-c",
      "user.email=committer@example.local",
      "commit",
      "-m",
      "initial commit",
    ],
    { cwd: dir },
  );

  const rev = await execGit(["rev-parse", "HEAD"], { cwd: dir });
  return rev.stdout.trim();
}

before(async () => {
  tmpDir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent ws test-")),
  );
  repoDir = path.join(tmpDir, "repo with spaces");
  worktreeRoot = path.join(tmpDir, "worktrees with spaces");
  outsideDir = path.join(tmpDir, "outside with spaces");

  fs.mkdirSync(worktreeRoot, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  baseSha = await initRepoWithCommit(repoDir);
});

after(async () => {
  // Prune any remaining worktrees before removing temp dir
  try {
    await execGit(["worktree", "prune"], { cwd: repoDir });
  } catch {
    // Ignore cleanup errors
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("shortRunId and worktreePathFor", () => {
  it("derives a 12-char filesystem-safe id deterministically", () => {
    const id1 = shortRunId("run-alpha-42");
    const id2 = shortRunId("run-alpha-42");
    assert.equal(id1, id2);
    assert.equal(id1.length, 12);
    assert.match(id1, /^[0-9a-f]{12}$/);

    const uuid = "ba0e9fcb-f1d2-4848-8104-ad949e3d9e65";
    const shortUuid = shortRunId(uuid);
    assert.equal(shortUuid, "ba0e9fcbf1d2");
  });

  it("constructs worktree path under <worktreeRoot>/command-center/<shortId>", () => {
    const p = worktreePathFor(worktreeRoot, "run-alpha-42");
    const expected = path.join(
      worktreeRoot,
      "command-center",
      shortRunId("run-alpha-42"),
    );
    assert.equal(p, expected);
  });
});

describe("createRunWorktree", () => {
  it("creates worktree on agent/<id> at baseSha without touching user uncommitted changes", async () => {
    const runId = "test-run-create-1";
    const shortId = shortRunId(runId);

    // Create uncommitted working tree and staged index changes in main checkout
    const readmePath = path.join(repoDir, "README.md");
    const stagedPath = path.join(repoDir, "staged-user-file.txt");
    fs.writeFileSync(readmePath, "# Changed by user in main\n");
    fs.writeFileSync(stagedPath, "staged content by user\n");
    await execGit(["add", "staged-user-file.txt"], { cwd: repoDir });

    const statusBefore = await execGit(["status", "--porcelain"], {
      cwd: repoDir,
    });
    assert.ok(statusBefore.stdout.includes("M README.md"));
    assert.ok(statusBefore.stdout.includes("A  staged-user-file.txt"));

    // Create the run worktree
    const wt = await createRunWorktree({
      repoPath: repoDir,
      worktreeRoot,
      runId,
      baseRef: "HEAD",
    });

    try {
      assert.equal(wt.branch, `agent/${shortId}`);
      assert.equal(wt.baseSha, baseSha);
      assert.ok(fs.existsSync(wt.path));

      // Worktree is on agent/<shortId>
      const wtBranch = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: wt.path,
      });
      assert.equal(wtBranch.stdout.trim(), `agent/${shortId}`);

      // Worktree HEAD is at baseSha
      const wtHead = await execGit(["rev-parse", "HEAD"], { cwd: wt.path });
      assert.equal(wtHead.stdout.trim(), baseSha);

      // Worktree checkout has clean base README.md and does NOT have staged-user-file.txt
      const wtReadme = fs.readFileSync(path.join(wt.path, "README.md"), "utf8");
      assert.equal(wtReadme, "# Initial Workspace\n");
      assert.equal(fs.existsSync(path.join(wt.path, "staged-user-file.txt")), false);

      // Original repo is completely untouched
      const statusAfter = await execGit(["status", "--porcelain"], {
        cwd: repoDir,
      });
      assert.equal(statusAfter.stdout, statusBefore.stdout);
    } finally {
      // Revert user uncommitted changes in original repo
      await execGit(["reset", "HEAD", "staged-user-file.txt"], { cwd: repoDir });
      fs.rmSync(stagedPath, { force: true });
      await execGit(["checkout", "--", "README.md"], { cwd: repoDir });
    }
  });

  it("refuses if repoPath is not a git repo", async () => {
    await assert.rejects(
      async () => {
        await createRunWorktree({
          repoPath: outsideDir,
          worktreeRoot,
          runId: "invalid-repo-run",
        });
      },
      {
        message: /not a git repository/i,
      },
    );
  });
});

describe("commitStage", () => {
  it("returns null when there are no changes to commit", async () => {
    const runId = "test-run-commit-empty";
    const shortId = shortRunId(runId);
    const wt = await createRunWorktree({
      repoPath: repoDir,
      worktreeRoot,
      runId,
    });

    const sha = await commitStage(wt.path, "implement", shortId);
    assert.equal(sha, null);
  });

  it("commits changes with runner identity and message agent(<id>): implement", async () => {
    const runId = "test-run-commit-changes";
    const shortId = shortRunId(runId);
    const wt = await createRunWorktree({
      repoPath: repoDir,
      worktreeRoot,
      runId,
    });

    fs.writeFileSync(
      path.join(wt.path, "implement-output.txt"),
      "implemented code here\n",
    );

    const sha = await commitStage(wt.path, "implement", shortId);
    assert.ok(typeof sha === "string");
    assert.equal(sha.length, 40);

    // Verify commit author & committer
    const authorRes = await execGit(["log", "-1", "--format=%an <%ae>"], {
      cwd: wt.path,
    });
    assert.equal(
      authorRes.stdout.trim(),
      "Command Center Runner <runner@command-center.local>",
    );

    const committerRes = await execGit(["log", "-1", "--format=%cn <%ce>"], {
      cwd: wt.path,
    });
    assert.equal(
      committerRes.stdout.trim(),
      "Command Center Runner <runner@command-center.local>",
    );

    // Verify commit message
    const msgRes = await execGit(["log", "-1", "--format=%s"], {
      cwd: wt.path,
    });
    assert.equal(msgRes.stdout.trim(), `agent(${shortId}): implement`);
  });

  it("bypasses a failing pre-commit hook using --no-verify", async () => {
    const runId = "test-run-pre-commit-hook";
    const shortId = shortRunId(runId);
    const wt = await createRunWorktree({
      repoPath: repoDir,
      worktreeRoot,
      runId,
    });

    // The repo's own hooks dir (execGit overrides core.hooksPath, so do not
    // ask git for it).
    const hooksDir = path.join(repoDir, ".git", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });

    const hookFile = path.join(hooksDir, "pre-commit");
    fs.writeFileSync(
      hookFile,
      "#!/bin/sh\necho 'pre-commit hook triggered and failing' >&2\nexit 1\n",
    );
    try {
      fs.chmodSync(hookFile, 0o755);
    } catch {
      // Windows file systems might not support POSIX chmod
    }

    try {
      fs.writeFileSync(path.join(wt.path, "hook-test.txt"), "bypass hook test\n");
      const sha = await commitStage(wt.path, "implement", shortId);
      assert.ok(typeof sha === "string");
      assert.equal(sha.length, 40);
    } finally {
      fs.rmSync(hookFile, { force: true });
    }
  });
});

describe("diffSummary", () => {
  it("summarizes added, modified, deleted, and renamed files with correct counts", async () => {
    const runId = "test-run-diff-summary";
    const shortId = shortRunId(runId);
    const wt = await createRunWorktree({
      repoPath: repoDir,
      worktreeRoot,
      runId,
    });

    // 1. Added file: 3 lines
    fs.writeFileSync(path.join(wt.path, "added.txt"), "add 1\nadd 2\nadd 3\n");

    // 2. Modified file: replace 1 line with 3 lines (+3, -1)
    fs.writeFileSync(
      path.join(wt.path, "README.md"),
      "# Modified Workspace\nnew line A\nnew line B\n",
    );

    // 3. Deleted file: to-delete.txt had 4 lines in baseSha (+0, -4)
    fs.unlinkSync(path.join(wt.path, "to-delete.txt"));

    // 4. Renamed file: to-rename.txt -> renamed.txt (+1, -0)
    fs.unlinkSync(path.join(wt.path, "to-rename.txt"));
    fs.writeFileSync(
      path.join(wt.path, "renamed.txt"),
      "rename target content\nappended line\n",
    );

    await commitStage(wt.path, "implement", shortId);

    const summary = await diffSummary(wt.path, baseSha);

    // Verify added file
    const addedFile = summary.files.find((f) => f.path === "added.txt");
    assert.ok(addedFile);
    assert.equal(addedFile.status, "added");
    assert.equal(addedFile.additions, 3);
    assert.equal(addedFile.deletions, 0);
    assert.equal(addedFile.binary, false);

    // Verify modified file
    const modFile = summary.files.find((f) => f.path === "README.md");
    assert.ok(modFile);
    assert.equal(modFile.status, "modified");
    assert.equal(modFile.additions, 3);
    assert.equal(modFile.deletions, 1);
    assert.equal(modFile.binary, false);

    // Verify deleted file
    const delFile = summary.files.find((f) => f.path === "to-delete.txt");
    assert.ok(delFile);
    assert.equal(delFile.status, "deleted");
    assert.equal(delFile.additions, 0);
    assert.equal(delFile.deletions, 4);

    // Verify renamed file
    const renFile = summary.files.find((f) => f.path === "renamed.txt");
    assert.ok(renFile);
    assert.equal(renFile.status, "renamed");
    assert.equal(renFile.oldPath, "to-rename.txt");
    assert.equal(renFile.additions, 1);
    assert.equal(renFile.deletions, 0);

    // Totals
    assert.equal(summary.totals.files, 4);
    assert.equal(summary.totals.additions, 3 + 3 + 0 + 1);
    assert.equal(summary.totals.deletions, 0 + 1 + 4 + 0);
  });

  it("flags binary files and reports zero line counts", async () => {
    const runId = "test-run-diff-binary";
    const shortId = shortRunId(runId);
    const wt = await createRunWorktree({
      repoPath: repoDir,
      worktreeRoot,
      runId,
    });

    const binaryBuffer = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00]);
    fs.writeFileSync(path.join(wt.path, "data.bin"), binaryBuffer);

    await commitStage(wt.path, "checks", shortId);

    const summary = await diffSummary(wt.path, baseSha);
    const binFile = summary.files.find((f) => f.path === "data.bin");
    assert.ok(binFile);
    assert.equal(binFile.binary, true);
    assert.equal(binFile.additions, 0);
    assert.equal(binFile.deletions, 0);
  });

  it("ignores CRLF-only line-ending changes (--ignore-cr-at-eol)", async () => {
    const runId = "test-run-diff-crlf";
    const shortId = shortRunId(runId);
    const wt = await createRunWorktree({
      repoPath: repoDir,
      worktreeRoot,
      runId,
    });

    // In baseSha, crlf.txt was "first line\nsecond line\n"
    // Change only line endings to CRLF: "first line\r\nsecond line\r\n"
    fs.writeFileSync(
      path.join(wt.path, "crlf.txt"),
      "first line\r\nsecond line\r\n",
    );

    await commitStage(wt.path, "review", shortId);

    const summary = await diffSummary(wt.path, baseSha);
    const crlfFile = summary.files.find((f) => f.path === "crlf.txt");
    // Under --ignore-cr-at-eol, git sees no diff for this file
    assert.equal(crlfFile, undefined);
  });

  it("orders excluded and out-of-scope files first, then grouped by directory, lines descending", async () => {
    const runId = "test-run-diff-order";
    const shortId = shortRunId(runId);
    const wt = await createRunWorktree({
      repoPath: repoDir,
      worktreeRoot,
      runId,
    });

    fs.mkdirSync(path.join(wt.path, "secrets"), { recursive: true });
    fs.mkdirSync(path.join(wt.path, "outside"), { recursive: true });
    fs.mkdirSync(path.join(wt.path, "src", "components"), { recursive: true });

    // Excluded file (matches secrets/**)
    fs.writeFileSync(
      path.join(wt.path, "secrets", "api.key"),
      "SECRET_KEY_123\n",
    );

    // Out-of-scope file (scope is src/**, this is outside/**)
    fs.writeFileSync(
      path.join(wt.path, "outside", "ignored.txt"),
      "outside 1\noutside 2\n",
    );

    // In-scope file in src with 2 lines changed
    fs.writeFileSync(
      path.join(wt.path, "src", "small.ts"),
      "const a = 1;\nconst b = 2;\n",
    );

    // In-scope file in src with 5 lines changed
    fs.writeFileSync(
      path.join(wt.path, "src", "big.ts"),
      "1\n2\n3\n4\n5\n",
    );

    // In-scope file in src/components with 3 lines changed
    fs.writeFileSync(
      path.join(wt.path, "src", "components", "widget.ts"),
      "x\ny\nz\n",
    );

    await commitStage(wt.path, "final", shortId);

    const summary = await diffSummary(wt.path, baseSha, {
      excludedPaths: ["secrets/**"],
      scopePaths: ["src/**"],
    });

    const filePaths = summary.files.map((f) => f.path);

    // First two must be the flagged files: excluded or outOfScope
    const firstTwo = summary.files.slice(0, 2);
    assert.ok(firstTwo.every((f) => f.excluded || f.outOfScope));

    const secretEntry = summary.files.find((f) => f.path === "secrets/api.key");
    assert.ok(secretEntry);
    assert.equal(secretEntry.excluded, true);

    const outsideEntry = summary.files.find(
      (f) => f.path === "outside/ignored.txt",
    );
    assert.ok(outsideEntry);
    assert.equal(outsideEntry.outOfScope, true);

    // Remaining in-scope files must be grouped by directory and ordered by lines changed descending
    const remaining = summary.files.slice(2);
    assert.ok(remaining.every((f) => !f.excluded && !f.outOfScope));

    // In "src", big.ts (5 lines) must precede small.ts (2 lines)
    const bigIndex = filePaths.indexOf("src/big.ts");
    const smallIndex = filePaths.indexOf("src/small.ts");
    assert.ok(bigIndex < smallIndex, "big.ts (5 lines) should precede small.ts (2 lines)");
  });
});

describe("removeRunWorktree", () => {
  it("refuses to remove a path outside <worktreeRoot>/command-center", async () => {
    // Attempt removing repoDir directly
    const resRepo = await removeRunWorktree({
      repoPath: repoDir,
      worktreePath: repoDir,
      worktreeRoot,
    });
    assert.equal(resRepo.ok, false);
    assert.ok(!resRepo.ok && resRepo.reason.includes("not inside"));

    // Attempt removing outsideDir
    const resOutside = await removeRunWorktree({
      repoPath: repoDir,
      worktreePath: outsideDir,
      worktreeRoot,
    });
    assert.equal(resOutside.ok, false);
    assert.ok(!resOutside.ok && resOutside.reason.includes("not inside"));

    // Attempt removing the command-center root folder itself
    const cmdCenterRoot = path.join(worktreeRoot, "command-center");
    fs.mkdirSync(cmdCenterRoot, { recursive: true });
    const resCmdCenter = await removeRunWorktree({
      repoPath: repoDir,
      worktreePath: cmdCenterRoot,
      worktreeRoot,
    });
    assert.equal(resCmdCenter.ok, false);
    assert.ok(!resCmdCenter.ok && resCmdCenter.reason.includes("not inside"));
  });

  it("removes the worktree directory while leaving the branch intact", async () => {
    const runId = "test-run-remove-ok";
    const shortId = shortRunId(runId);
    const wt = await createRunWorktree({
      repoPath: repoDir,
      worktreeRoot,
      runId,
    });

    assert.ok(fs.existsSync(wt.path));

    const removeResult = await removeRunWorktree({
      repoPath: repoDir,
      worktreePath: wt.path,
      worktreeRoot,
    });
    assert.equal(removeResult.ok, true);

    // Worktree folder is removed
    assert.equal(fs.existsSync(wt.path), false);

    // Branch agent/<shortId> still exists in repo
    const branches = await execGit(["branch", "--list", wt.branch], {
      cwd: repoDir,
    });
    assert.ok(
      branches.stdout.includes(wt.branch),
      `Branch ${wt.branch} should still exist after worktree removal`,
    );
  });
});

describe("option injection and input validation", () => {
  it("refuses unsafe baseRef values", async () => {
    for (const bad of ["--upload-pack=x", "-x", "a..b", "a b", "HEAD~1", "x:y", ""]) {
      await assert.rejects(
        createRunWorktree({
          repoPath: repoDir,
          worktreeRoot,
          runId: "test-run-bad-ref",
          baseRef: bad,
        }),
        /baseRef/,
        `baseRef ${JSON.stringify(bad)} should be refused`,
      );
    }
  });

  it("refuses unsafe baseSha values in diffSummary", async () => {
    for (const bad of ["--output=x", "-x", "HEAD", "abc", "ZZZZZZZ", "abcdef1 --x"]) {
      await assert.rejects(
        diffSummary(repoDir, bad),
        /baseSha/,
        `baseSha ${JSON.stringify(bad)} should be refused`,
      );
    }
    assert.doesNotThrow(() => assertSafeBaseSha(baseSha));
  });

  it("commitStage validates stage and runShortId", async () => {
    const runId = "test-run-commit-validate";
    const shortId = shortRunId(runId);
    const wt = await createRunWorktree({ repoPath: repoDir, worktreeRoot, runId });
    fs.writeFileSync(path.join(wt.path, "v.txt"), "v\n");

    await assert.rejects(commitStage(wt.path, "not-a-stage", shortId), /Invalid stage/);
    await assert.rejects(commitStage(wt.path, "--amend", shortId), /Invalid stage/);
    await assert.rejects(commitStage(wt.path, "implement", "ZZZ"), /Invalid runShortId/);
    await assert.rejects(commitStage(wt.path, "implement", "-m evil"), /Invalid runShortId/);

    // "stopped" is allowed for Stop commits.
    const sha = await commitStage(wt.path, "stopped", shortId);
    assert.ok(typeof sha === "string" && sha.length === 40);
  });
});

describe("repo config cannot execute programs", () => {
  it("still commits when core.hooksPath points at a failing pre-commit hook", async () => {
    const hooksDir = path.join(tmpDir, "evil hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const hook = path.join(hooksDir, "pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    try {
      fs.chmodSync(hook, 0o755);
    } catch {
      // not supported on this file system
    }
    await execGit(["config", "core.hooksPath", hooksDir], { cwd: repoDir });
    try {
      const runId = "test-run-hookspath";
      const shortId = shortRunId(runId);
      const wt = await createRunWorktree({ repoPath: repoDir, worktreeRoot, runId });
      fs.writeFileSync(path.join(wt.path, "hp.txt"), "x\n");
      const sha = await commitStage(wt.path, "implement", shortId);
      assert.ok(typeof sha === "string" && sha.length === 40);
    } finally {
      await execGit(["config", "--unset", "core.hooksPath"], { cwd: repoDir });
    }
  });

  it("does not write core.longpaths into the user's repo config", async () => {
    const runId = "test-run-no-config-write";
    await createRunWorktree({ repoPath: repoDir, worktreeRoot, runId });
    const cfg = fs.readFileSync(path.join(repoDir, ".git", "config"), "utf8");
    assert.equal(/longpaths/i.test(cfg), false);
  });
});

describe("removeRunWorktree when the folder is already gone", () => {
  it("prunes the registration, returns ok and keeps the branch", async () => {
    const runId = "test-run-remove-gone";
    const wt = await createRunWorktree({ repoPath: repoDir, worktreeRoot, runId });
    fs.rmSync(wt.path, { recursive: true, force: true });

    const res = await removeRunWorktree({
      repoPath: repoDir,
      worktreePath: wt.path,
      worktreeRoot,
    });
    assert.equal(res.ok, true);

    const list = await execGit(["worktree", "list", "--porcelain"], { cwd: repoDir });
    assert.equal(list.stdout.includes(path.basename(wt.path)), false);

    const branches = await execGit(["branch", "--list", wt.branch], { cwd: repoDir });
    assert.ok(branches.stdout.includes(wt.branch));
  });

  it("still refuses a missing path outside command-center", async () => {
    const res = await removeRunWorktree({
      repoPath: repoDir,
      worktreePath: path.join(outsideDir, "nope"),
      worktreeRoot,
    });
    assert.equal(res.ok, false);
  });
});

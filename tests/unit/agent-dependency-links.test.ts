/**
 * Dependency folders linked into run worktrees (AW4-14).
 *
 * Real temp git repos (folders with spaces); no network. The key rule: removing
 * a worktree never deletes anything inside the project's own folders.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { linkDependencies, unlinkDependencies } from "../../src/core/agents/dependency-links";
import { createRunWorkspace } from "../../src/core/agents/snapshot";
import { commitStage, removeRunWorktree, shortRunId } from "../../src/core/agents/workspace";

const tempDirs: string[] = [];
let counter = 0;

after(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.local", "-c", "core.autocrlf=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

interface Fx {
  repo: string;
  worktreeRoot: string;
  worktree: string;
  runId: string;
}

/** A repo whose .gitignore lists `node_modules/` and `.venv`, with a real worktree. */
async function makeFx(): Promise<Fx> {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dep links ")));
  tempDirs.push(root);
  const repo = path.join(root, "my repo");
  const worktreeRoot = path.join(root, "work trees");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(worktreeRoot, { recursive: true });
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n.venv\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# hi\n");
  git(repo, "init", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "user.name", "Test Owner");
  git(repo, "config", "user.email", "owner@example.local");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  const runId = `run-dep-${++counter}`;
  const ws = await createRunWorkspace({ repoPath: repo, worktreeRoot, runId });
  return { repo, worktreeRoot, worktree: ws.path, runId };
}

function makeModules(repo: string, name = "node_modules"): string {
  const dir = path.join(repo, name);
  fs.mkdirSync(path.join(dir, "pkg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "pkg", "index.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(dir, "top.txt"), "top\n");
  return dir;
}

describe("linkDependencies", () => {
  it("links an ignored folder and the agent can read a file through it", async () => {
    const fx = await makeFx();
    makeModules(fx.repo);
    const res = await linkDependencies({ projectPath: fx.repo, worktreePath: fx.worktree, names: ["node_modules"] });
    assert.deepEqual(res, { linked: ["node_modules"], skipped: [] });
    assert.ok(fs.lstatSync(path.join(fx.worktree, "node_modules")).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(fx.worktree, "node_modules", "pkg", "index.js"), "utf8"), "module.exports = 1;\n");
  });

  it("skips a folder Git does not ignore, and leaves no link behind", async () => {
    const fx = await makeFx();
    makeModules(fx.repo, "vendor");
    const res = await linkDependencies({ projectPath: fx.repo, worktreePath: fx.worktree, names: ["vendor"] });
    assert.deepEqual(res.linked, []);
    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0]?.name, "vendor");
    assert.match(res.skipped[0]?.reason ?? "", /not ignored by Git/);
    assert.equal(fs.existsSync(path.join(fx.worktree, "vendor")), false);
  });

  it("skips a missing source and a source that is itself a link", async () => {
    const fx = await makeFx();
    const real = path.join(path.dirname(fx.repo), "elsewhere");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(fx.repo, ".venv"), process.platform === "win32" ? "junction" : "dir");
    const res = await linkDependencies({ projectPath: fx.repo, worktreePath: fx.worktree, names: ["node_modules", ".venv"] });
    assert.deepEqual(res.linked, []);
    assert.deepEqual(res.skipped.map((s) => s.name), ["node_modules", ".venv"]);
    assert.match(res.skipped[0]?.reason ?? "", /not found/);
  });

  it("skips a name that already exists in the worktree", async () => {
    const fx = await makeFx();
    makeModules(fx.repo);
    fs.mkdirSync(path.join(fx.worktree, "node_modules"));
    const res = await linkDependencies({ projectPath: fx.repo, worktreePath: fx.worktree, names: ["node_modules"] });
    assert.deepEqual(res.linked, []);
    assert.match(res.skipped[0]?.reason ?? "", /already exists/);
    assert.equal(fs.lstatSync(path.join(fx.worktree, "node_modules")).isSymbolicLink(), false);
  });

  it("rejects names that are not a single folder name", async () => {
    const fx = await makeFx();
    makeModules(fx.repo);
    const names = ["..", ".", "a/b", "a\b", "../node_modules", "", "C:evil"];
    const res = await linkDependencies({ projectPath: fx.repo, worktreePath: fx.worktree, names });
    assert.deepEqual(res.linked, []);
    assert.equal(res.skipped.length, names.length);
  });
});

describe("unlinkDependencies and removeRunWorktree", () => {
  it("unlinkDependencies removes the link; the project folder and its files stay", async () => {
    const fx = await makeFx();
    const modules = makeModules(fx.repo);
    await linkDependencies({ projectPath: fx.repo, worktreePath: fx.worktree, names: ["node_modules"] });
    assert.deepEqual(unlinkDependencies(fx.worktree), ["node_modules"]);
    assert.equal(fs.existsSync(path.join(fx.worktree, "node_modules")), false);
    assert.equal(fs.readFileSync(path.join(modules, "pkg", "index.js"), "utf8"), "module.exports = 1;\n");
    assert.equal(fs.readFileSync(path.join(modules, "top.txt"), "utf8"), "top\n");
  });

  it("removeRunWorktree leaves every file in the project's node_modules intact", async () => {
    const fx = await makeFx();
    const modules = makeModules(fx.repo);
    await linkDependencies({ projectPath: fx.repo, worktreePath: fx.worktree, names: ["node_modules"] });
    const res = await removeRunWorktree({ repoPath: fx.repo, worktreePath: fx.worktree, worktreeRoot: fx.worktreeRoot });
    assert.deepEqual(res, { ok: true });
    assert.equal(fs.existsSync(fx.worktree), false);
    assert.equal(fs.readFileSync(path.join(modules, "pkg", "index.js"), "utf8"), "module.exports = 1;\n");
    assert.equal(fs.readFileSync(path.join(modules, "top.txt"), "utf8"), "top\n");
  });

  it("a stage commit after linking does not include the linked folder", async () => {
    const fx = await makeFx();
    makeModules(fx.repo);
    await linkDependencies({ projectPath: fx.repo, worktreePath: fx.worktree, names: ["node_modules"] });
    fs.writeFileSync(path.join(fx.worktree, "feature.txt"), "feature\n");
    const sha = await commitStage(fx.worktree, "implement", shortRunId(fx.runId));
    assert.ok(sha);
    const files = git(fx.worktree, "show", "--name-only", "--format=", sha).split(/\r?\n/).filter(Boolean);
    assert.deepEqual(files, ["feature.txt"]);
  });
});

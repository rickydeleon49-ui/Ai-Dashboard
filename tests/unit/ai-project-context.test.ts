/**
 * Project context for the AI workspace.
 *
 * The branch is read out of `.git/HEAD` rather than by running git, so these
 * tests build real git directories on disk — which is the whole surface, since
 * there is no process to mock.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { cleanup, migrate } from "../helpers/db";

let context: typeof import("../../src/core/projects/context");
let root = "";

before(async () => {
  await migrate();
  context = await import("../../src/core/projects/context");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-git-"));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  cleanup();
});

/** Creates a directory containing a .git with the given HEAD contents. */
function repository(name: string, head: string): string {
  const directory = path.join(root, name);
  fs.mkdirSync(path.join(directory, ".git"), { recursive: true });
  fs.writeFileSync(path.join(directory, ".git", "HEAD"), head);
  return directory;
}

function project(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "proj_1",
    name: "Flight Deck",
    description: "Test project",
    source: "manual",
    type: "software",
    status: "active",
    tags: ["aviation"],
    repositoryUrl: null,
    projectUrl: null,
    localPath: null,
    notes: null,
    favorite: false,
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: null,
    externalId: null,
    syncedAt: null,
    metadata: {},
    ...overrides,
  } as Parameters<typeof context.buildProjectContext>[0];
}

describe("git information", () => {
  it("reads the checked-out branch", () => {
    const directory = repository("on-branch", "ref: refs/heads/dev/flight-deck\n");
    assert.deepEqual(context.readGitInfo(directory), {
      isRepository: true,
      branch: "dev/flight-deck",
      detachedAt: null,
    });
  });

  it("reports a detached head instead of inventing a branch", () => {
    const directory = repository("detached", "9f1c2b3d4e5f60718293a4b5c6d7e8f901234567\n");
    const info = context.readGitInfo(directory);
    assert.equal(info.isRepository, true);
    assert.equal(info.branch, null);
    assert.equal(info.detachedAt, "9f1c2b3");
  });

  it("follows a .git file to a linked worktree", () => {
    const real = path.join(root, "worktree-git");
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, "HEAD"), "ref: refs/heads/feature\n");

    const directory = path.join(root, "worktree");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, ".git"), `gitdir: ${real}\n`);

    assert.equal(context.readGitInfo(directory).branch, "feature");
  });

  it("says a plain folder is not a repository", () => {
    const directory = path.join(root, "plain");
    fs.mkdirSync(directory, { recursive: true });
    assert.deepEqual(context.readGitInfo(directory), {
      isRepository: false,
      branch: null,
      detachedAt: null,
    });
  });

  it("does not fail on a repository with an unreadable HEAD", () => {
    const directory = path.join(root, "headless");
    fs.mkdirSync(path.join(directory, ".git"), { recursive: true });
    const info = context.readGitInfo(directory);
    assert.equal(info.isRepository, true);
    assert.equal(info.branch, null);
  });
});

describe("project context", () => {
  it("reports a missing local folder rather than pretending it is there", () => {
    const built = context.buildProjectContext(
      project({ localPath: path.join(root, "does-not-exist") }),
    );
    assert.equal(built.localPathExists, false);
    assert.equal(built.git.isRepository, false);
  });

  it("carries the branch through to the context", () => {
    const directory = repository("with-branch", "ref: refs/heads/main\n");
    const built = context.buildProjectContext(project({ localPath: directory }));
    assert.equal(built.localPathExists, true);
    assert.equal(built.git.branch, "main");
  });

  it("expands a leading ~ to the home directory", () => {
    assert.equal(context.resolveLocalPath("~/code"), path.join(os.homedir(), "code"));
  });

  it("describes the project without sending any file contents", () => {
    const directory = repository("prompted", "ref: refs/heads/dev/flight-deck\n");
    const prompt = context.projectSystemPrompt(
      context.buildProjectContext(
        project({ localPath: directory, repositoryUrl: "https://github.com/x/y" }),
      ),
    );

    assert.match(prompt, /Flight Deck/);
    assert.match(prompt, /dev\/flight-deck/);
    assert.match(prompt, /https:\/\/github\.com\/x\/y/);
    assert.match(prompt, /not been given the contents of any file/);
  });

  it("says nothing about git for a project with no folder", () => {
    const prompt = context.projectSystemPrompt(context.buildProjectContext(project()));
    assert.doesNotMatch(prompt, /branch/i);
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_KINDS,
  KIND_LABELS,
  STATUS_LABELS,
  approveBlocker,
  buildTarget,
  isOpen,
  previewLines,
  sortNewestFirst,
  type Approval,
} from "../../src/components/agents/runs/approvals-logic";

test("APPROVAL_KINDS and LABELS", () => {
  assert.equal(APPROVAL_KINDS.length, 5);
  for (const kind of APPROVAL_KINDS) {
    assert.ok(typeof KIND_LABELS[kind] === "string" && KIND_LABELS[kind].length > 0);
  }
  const statuses = [
    "pending",
    "approved",
    "rejected",
    "executing",
    "done",
    "failed",
  ] as const;
  for (const status of statuses) {
    assert.ok(typeof STATUS_LABELS[status] === "string" && STATUS_LABELS[status].length > 0);
  }
});

test("isOpen returns true only for pending, approved, executing", () => {
  assert.equal(isOpen("pending"), true);
  assert.equal(isOpen("approved"), true);
  assert.equal(isOpen("executing"), true);
  assert.equal(isOpen("rejected"), false);
  assert.equal(isOpen("done"), false);
  assert.equal(isOpen("failed"), false);
});

test("sortNewestFirst returns new array sorted newest requestedAt first", () => {
  const original: Approval[] = [
    {
      id: "1",
      runId: "run-1",
      kind: "merge",
      status: "done",
      preview: {},
      target: {},
      result: null,
      error: null,
      requestedAt: "2026-11-01T10:00:00Z",
      decidedAt: null,
      executedAt: null,
    },
    {
      id: "2",
      runId: "run-1",
      kind: "push",
      status: "pending",
      preview: {},
      target: {},
      result: null,
      error: null,
      requestedAt: "2026-11-03T10:00:00Z",
      decidedAt: null,
      executedAt: null,
    },
    {
      id: "3",
      runId: "run-1",
      kind: "draft_pr",
      status: "executing",
      preview: {},
      target: {},
      result: null,
      error: null,
      requestedAt: "2026-11-02T10:00:00Z",
      decidedAt: null,
      executedAt: null,
    },
  ];

  const sorted = sortNewestFirst(original);
  assert.notEqual(sorted, original);
  assert.equal(original[0]?.id, "1"); // not mutated
  assert.deepEqual(
    sorted.map((a) => a.id),
    ["2", "3", "1"],
  );
});

test("buildTarget: merge required targetBranch with trimming", () => {
  assert.deepEqual(buildTarget("merge", {}), {
    error: "Enter the branch to merge into",
  });
  assert.deepEqual(buildTarget("merge", { targetBranch: "   " }), {
    error: "Enter the branch to merge into",
  });
  assert.deepEqual(buildTarget("merge", { targetBranch: "  main  " }), {
    target: { targetBranch: "main" },
  });
});

test("buildTarget: push optional remote with trimming", () => {
  assert.deepEqual(buildTarget("push", {}), {
    target: {},
  });
  assert.deepEqual(buildTarget("push", { remote: "   " }), {
    target: {},
  });
  assert.deepEqual(buildTarget("push", { remote: "  origin  " }), {
    target: { remote: "origin" },
  });
});

test("buildTarget: draft_pr required base branch and optional trimmed remote and title", () => {
  assert.deepEqual(buildTarget("draft_pr", {}), {
    error: "Enter the base branch",
  });
  assert.deepEqual(buildTarget("draft_pr", { base: "   " }), {
    error: "Enter the base branch",
  });
  assert.deepEqual(buildTarget("draft_pr", { base: "  main  " }), {
    target: { base: "main" },
  });
  assert.deepEqual(
    buildTarget("draft_pr", {
      base: "  main  ",
      remote: "  upstream  ",
      title: "  Add new feature  ",
    }),
    {
      target: {
        base: "main",
        remote: "upstream",
        title: "Add new feature",
      },
    },
  );
  assert.deepEqual(
    buildTarget("draft_pr", {
      base: "main",
      remote: "   ",
      title: "   ",
    }),
    {
      target: { base: "main" },
    },
  );
});

test("buildTarget: apply_back and delete_worktree return empty target", () => {
  assert.deepEqual(buildTarget("apply_back", {}), { target: {} });
  assert.deepEqual(buildTarget("apply_back", { extra: "data" }), { target: {} });
  assert.deepEqual(buildTarget("delete_worktree", {}), { target: {} });
  assert.deepEqual(buildTarget("delete_worktree", { branch: "feat" }), { target: {} });
});

test("previewLines handles empty {} preview without throwing for all kinds", () => {
  for (const kind of APPROVAL_KINDS) {
    const lines = previewLines({ kind, preview: {} });
    assert.ok(Array.isArray(lines));
    assert.equal(lines.length, 0);
  }
});

test("previewLines: merge full preview variations", () => {
  const full = previewLines({
    kind: "merge",
    preview: {
      commitsAhead: 3,
      runBranch: "run/x",
      targetBranch: "main",
      conflicts: false,
      dirty: false,
    },
  });
  assert.deepEqual(full, [
    "3 commits from run/x into main",
    "Conflicts: none",
  ]);

  const conflictsAndDirty = previewLines({
    kind: "merge",
    preview: {
      commitsAhead: 1,
      runBranch: "run/x",
      targetBranch: "main",
      conflicts: true,
      conflictFiles: ["src/a.ts", "src/b.ts"],
      dirty: true,
      dirtyFiles: ["file1.txt"],
    },
  });
  assert.deepEqual(conflictsAndDirty, [
    "1 commit from run/x into main",
    "Conflicts in 2 files: src/a.ts, src/b.ts",
    "Your checkout has uncommitted changes (1 file)",
  ]);

  const unknownConflicts = previewLines({
    kind: "merge",
    preview: {
      conflicts: null,
      dirty: true,
      dirtyFiles: ["a", "b"],
    },
  });
  assert.deepEqual(unknownConflicts, [
    "Conflicts: could not check",
    "Your checkout has uncommitted changes (2 files)",
  ]);
});

test("previewLines: push full preview", () => {
  const lines = previewLines({
    kind: "push",
    preview: {
      branch: "run/x",
      remote: "origin",
      remoteUrl: "https://github.com/foo/bar.git",
      commitsAhead: 2,
    },
  });
  assert.deepEqual(lines, [
    "Push run/x to origin (https://github.com/foo/bar.git)",
    "2 new commits",
  ]);

  const withoutUrl = previewLines({
    kind: "push",
    preview: {
      branch: "run/x",
      remote: "origin",
      commitsAhead: 1,
    },
  });
  assert.deepEqual(withoutUrl, [
    "Push run/x to origin",
    "1 new commit",
  ]);
});

test("previewLines: draft_pr full preview", () => {
  const lines = previewLines({
    kind: "draft_pr",
    preview: {
      owner: "owner",
      repo: "repo",
      head: "head",
      base: "base",
      title: "Add approval panel",
      changedFiles: ["file1.ts", "file2.ts"],
    },
  });
  assert.deepEqual(lines, [
    "Draft PR owner/repo: head -> base",
    "Title: Add approval panel",
    "2 changed files",
  ]);
});

test("previewLines: apply_back full preview", () => {
  const lines = previewLines({
    kind: "apply_back",
    preview: {
      writes: 3,
      deletes: 1,
      sourceDir: "/home/user/project",
    },
  });
  assert.deepEqual(lines, [
    "3 files to write, 1 to delete in /home/user/project",
  ]);

  const singleWrite = previewLines({
    kind: "apply_back",
    preview: {
      writes: 1,
      deletes: 0,
      sourceDir: "/home/user/project",
    },
  });
  assert.deepEqual(singleWrite, [
    "1 file to write, 0 to delete in /home/user/project",
  ]);
});

test("previewLines: delete_worktree full preview", () => {
  const lines = previewLines({
    kind: "delete_worktree",
    preview: {
      worktreePath: "/tmp/worktree-123",
      branch: "run/feat",
      unmergedCommits: [{ sha: "abcdef123456", subject: "commit 1" }],
      uncommittedFiles: ["uncommitted.txt"],
    },
  });
  assert.deepEqual(lines, [
    "Deletes /tmp/worktree-123; the branch run/feat is kept",
    "1 unmerged commit",
    "1 uncommitted file will be lost",
  ]);

  const noUncommitted = previewLines({
    kind: "delete_worktree",
    preview: {
      worktreePath: "/tmp/worktree-123",
      branch: "run/feat",
      unmergedCommits: [],
      uncommittedFiles: [],
    },
  });
  assert.deepEqual(noUncommitted, [
    "Deletes /tmp/worktree-123; the branch run/feat is kept",
    "0 unmerged commits",
  ]);
});

test("approveBlocker returns correct reason for pending merge and null otherwise", () => {
  // Pending merge with dirty checkout
  assert.equal(
    approveBlocker({
      kind: "merge",
      status: "pending",
      preview: { dirty: true, conflicts: false },
    }),
    "Fix this before approving: commit or stash your changes",
  );

  // Pending merge with dirty checkout AND conflicts: dirty takes precedence
  assert.equal(
    approveBlocker({
      kind: "merge",
      status: "pending",
      preview: { dirty: true, conflicts: true },
    }),
    "Fix this before approving: commit or stash your changes",
  );

  // Pending merge with conflicts only
  assert.equal(
    approveBlocker({
      kind: "merge",
      status: "pending",
      preview: { dirty: false, conflicts: true },
    }),
    "This merge has conflicts; resolve them in your repo or request a new preview",
  );

  // Pending merge without conflicts or dirty
  assert.equal(
    approveBlocker({
      kind: "merge",
      status: "pending",
      preview: { dirty: false, conflicts: false },
    }),
    null,
  );

  // Non-pending status returns null even if dirty/conflicts
  assert.equal(
    approveBlocker({
      kind: "merge",
      status: "approved",
      preview: { dirty: true, conflicts: true },
    }),
    null,
  );
  assert.equal(
    approveBlocker({
      kind: "merge",
      status: "executing",
      preview: { dirty: true },
    }),
    null,
  );

  // Other kinds return null even if dirty
  assert.equal(
    approveBlocker({
      kind: "push",
      status: "pending",
      preview: { dirty: true },
    }),
    null,
  );

  // Missing preview returns null
  assert.equal(
    approveBlocker({
      kind: "merge",
      status: "pending",
      preview: {},
    }),
    null,
  );
});

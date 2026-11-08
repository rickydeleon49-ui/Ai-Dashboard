/**
 * AW.4 agent pages — genuine browser interaction (Chromium, production build,
 * desktop/SQLite server).
 *
 * The runner process is not running here, so finished runs, events, tasks and
 * task activity are written straight into the throwaway database, in the shapes
 * the orchestrator records. Approvals and the cleanup preview use a real temp git
 * repository inside the e2e workspace root.
 *
 * 1. Project policy editor: add, save, reload, persist; invalid entry; warning.
 * 2. Next eligible task in the New run form.
 * 3. A finished run linked to a task: outcome in the task's activity, task unchanged.
 * 4. Approvals card: delete-worktree preview and reject; empty merge branch; unfinished run.
 * 5. Resume: shown for an interrupted run, not for a succeeded one; refusal in red.
 * 6. Dismiss, show dismissed, restore.
 * 7. Worktree cleanup setting and its preview (nothing deleted).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { Page } from "playwright";
import {
  baseURL,
  e2eDatabasePath,
  newPage,
  pageErrors,
  start,
  stop,
} from "./helpers";

let seedPage: Page;
let root = "";
let wsRoot = "";
let wtRoot = "";
let repoPath = "";
let projectId = "";

const DAY_MS = 86_400_000;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/** A real repository with one commit; identity is set per repo because CI has no global one. */
function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "E2E Tester"]);
  git(dir, ["config", "user.email", "e2e@example.com"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# e2e repo\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
}

/** Adds a run worktree the way the runner lays it out, on the branch `agent/<12 hex>`. */
function addWorktree(branchHex: string, folder: string): { branch: string; dir: string } {
  const branch = `agent/${branchHex}`;
  const dir = path.join(wtRoot, "command-center", folder);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(repoPath, ["worktree", "add", "-q", "-b", branch, dir]);
  return { branch, dir };
}

type SeedRun = {
  id: string;
  task: string;
  status?: string;
  projectId?: string;
  taskId?: string | null;
  branch?: string | null;
  workspacePath?: string | null;
  baseRef?: string | null;
  dismissedAt?: string | null;
  outcome?: unknown;
};

const FINISHED = ["succeeded", "failed", "stopped", "interrupted"];

function seedRun(db: Database.Database, run: SeedRun): void {
  const status = run.status ?? "succeeded";
  const finished = FINISHED.includes(status);
  const request = {
    projectId: run.projectId ?? projectId,
    task: run.task,
    checks: [],
    roles: { implementer: { provider: "claude-code" } },
  };
  db.prepare(
    `INSERT INTO agent_run
       (id, project_id, status, stage, request, outcome, workspace_kind, workspace_path,
        base_ref, branch, task_id, dismissed_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${finished ? "datetime('now')" : "NULL"})`,
  ).run(
    run.id,
    run.projectId ?? projectId,
    status,
    finished ? "final" : "review",
    JSON.stringify(request),
    finished ? JSON.stringify(run.outcome ?? { status }) : null,
    run.workspacePath ? "git_worktree" : null,
    run.workspacePath ?? null,
    run.baseRef ?? null,
    run.branch ?? null,
    run.taskId ?? null,
    run.dismissedAt ?? null,
  );
  db.prepare(
    "INSERT INTO agent_run_event (run_id, seq, stage, agent, kind, payload) VALUES (?, 1, 'final', 'system', 'stage_finished', '{}')",
  ).run(run.id);
}

async function createProject(name: string, localPath: string): Promise<string> {
  const res = await seedPage.request.post(`${baseURL}/api/projects`, {
    data: { source: "manual", type: "software", status: "active", name },
  });
  assert.equal(res.status(), 201, await res.text());
  const id = ((await res.json()) as { project: { id: string } }).project.id;
  const db = new Database(e2eDatabasePath());
  try {
    db.prepare("UPDATE projects SET local_path = ? WHERE id = ?").run(localPath, id);
  } finally {
    db.close();
  }
  return id;
}

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(e2eDatabasePath());
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

before(async () => {
  await start();
  seedPage = await newPage();
  root = path.dirname(e2eDatabasePath());
  wsRoot = path.join(root, "ws");
  wtRoot = path.join(root, "wt");
  const storeRoot = path.join(root, "store");
  for (const dir of [wsRoot, wtRoot, storeRoot]) fs.mkdirSync(dir, { recursive: true });

  repoPath = path.join(wsRoot, "repo");
  initRepo(repoPath);

  const res = await seedPage.request.patch(`${baseURL}/api/agent-settings`, {
    data: { workspaceRoots: [wsRoot], worktreeRoot: wtRoot, runStore: storeRoot },
  });
  assert.equal(res.status(), 200, await res.text());

  projectId = await createProject("AW4 e2e project", repoPath);
});

after(async () => {
  await stop();
});

describe("AW.4 agent pages", () => {
  it("project policy editor saves, persists, rejects an invalid entry and warns about shared folders", async () => {
    const page = await newPage();
    try {
      await page.goto(`${baseURL}/projects/${projectId}`);
      await page.getByRole("link", { name: "Agent policy" }).click();
      await page.waitForURL(`**/settings/agents/projects/${projectId}`);

      // No shared folder yet, so no warning.
      const warning = page.getByText("These folders are shared with agent worktrees", { exact: false });
      assert.equal(await warning.count(), 0);

      await page.getByRole("button", { name: "Add Check" }).click();
      await page.getByLabel("Check 1 name", { exact: true }).fill("version");
      await page.getByLabel("Check 1 command", { exact: true }).fill("node --version");
      await page.getByRole("button", { name: "Add path" }).click();
      await page.getByLabel("Excluded path 1", { exact: true }).fill("secrets/**");
      await page.getByRole("button", { name: "Add folder" }).click();
      await page.getByLabel("Shared folder 1", { exact: true }).fill("node_modules");
      await warning.waitFor();

      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByText("Saved", { exact: true }).waitFor();

      await page.reload();
      assert.equal(await page.getByLabel("Check 1 name", { exact: true }).inputValue(), "version");
      const command = await page.getByLabel("Check 1 command", { exact: true }).inputValue();
      assert.ok(command.includes("--version"), `command kept its arguments: ${command}`);
      assert.ok(/node/i.test(command), `command still names node: ${command}`);
      assert.equal(await page.getByLabel("Excluded path 1", { exact: true }).inputValue(), "secrets/**");
      assert.equal(await page.getByLabel("Shared folder 1", { exact: true }).inputValue(), "node_modules");
      await warning.waitFor();

      // An invalid entry (a path that climbs out of the project) shows its error and is not saved.
      await page.getByRole("button", { name: "Add path" }).click();
      await page.getByLabel("Excluded path 2", { exact: true }).fill("../outside");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      const issue = page.locator("ul[role=alert]");
      await issue.waitFor();
      assert.match(await issue.innerText(), /must not contain ".." segments/);

      await page.reload();
      assert.equal(await page.getByLabel("Excluded path 1", { exact: true }).inputValue(), "secrets/**");
      assert.equal(await page.getByLabel("Excluded path 2", { exact: true }).count(), 0);

      assert.deepEqual(pageErrors(page), []);
    } finally {
      await page.context().close();
    }
  });

  it("suggests the next eligible task and never a blocked one", async () => {
    const dir = path.join(wsRoot, "tasks-project");
    fs.mkdirSync(dir, { recursive: true });
    const pid = await createProject("AW4 tasks project", dir);

    withDb((db) => {
      const insert = db.prepare(
        `INSERT INTO tasks (id, project_id, title, status, priority, due_date, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run("t_low", pid, "Tidy the changelog", "todo", "low", null, "2026-01-01T00:00:00.000Z");
      insert.run("t_high_late", pid, "Add pagination", "todo", "high", "2026-06-01", "2026-01-02T00:00:00.000Z");
      insert.run("t_high_soon", pid, "Fix the login redirect", "todo", "high", "2026-02-01", "2026-01-03T00:00:00.000Z");
      insert.run("t_blocker", pid, "Write the schema", "todo", "low", null, "2026-01-04T00:00:00.000Z");
      insert.run("t_blocked", pid, "Urgent but blocked work", "todo", "urgent", "2026-01-01", "2026-01-05T00:00:00.000Z");
      insert.run("t_busy", pid, "Urgent already running", "in_progress", "urgent", null, "2026-01-06T00:00:00.000Z");
      db.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)").run(
        "t_blocked",
        "t_blocker",
      );
    });

    const page = await newPage();
    try {
      await page.goto(`${baseURL}/agents`);
      const form = page.locator("form").filter({ hasText: "Linked task" });
      await form.getByLabel("Project").selectOption({ label: "AW4 tasks project" });

      const suggested = async (): Promise<string> => {
        await form.getByRole("button", { name: "Next task" }).click();
        const clear = form.getByRole("button", { name: "Clear" });
        await clear.waitFor();
        const text = await clear.locator("xpath=..").innerText();
        await clear.click();
        return text;
      };

      // The urgent task is blocked and the other urgent one is already in progress.
      assert.match(await suggested(), /Fix the login redirect/);

      // The suggestion never names a blocked task while its blocker is open.
      withDb((db) => db.prepare("UPDATE tasks SET status = 'done' WHERE id IN ('t_high_soon', 't_high_late')").run());
      const second = await suggested();
      assert.doesNotMatch(second, /Urgent but blocked work/);
      assert.match(second, /Tidy the changelog|Write the schema/);

      // Once the blocker is finished the blocked task becomes the next one.
      withDb((db) => db.prepare("UPDATE tasks SET status = 'done' WHERE id IN ('t_blocker', 't_low')").run());
      assert.match(await suggested(), /Urgent but blocked work/);

      assert.deepEqual(pageErrors(page), []);
    } finally {
      await page.context().close();
    }
  });

  it("records a linked run's outcome in the task's activity without changing the task", async () => {
    const taskId = "t_linked";
    withDb((db) => {
      db.prepare("INSERT INTO tasks (id, project_id, title, status) VALUES (?, ?, ?, 'todo')").run(
        taskId,
        projectId,
        "Linked task for a run",
      );
      seedRun(db, {
        id: "run_aw4_linked",
        task: "Do the linked work",
        taskId,
        outcome: {
          status: "succeeded",
          facts: { checks: [{ exitCode: 0, timedOut: false }], reviewVerdict: "approve" },
        },
      });
      // What postRunOutcomeToTask writes when a linked run ends.
      db.prepare(
        `INSERT INTO task_activity_event (id, workspace_id, project_id, task_id, type, details)
         VALUES (?, 'local', ?, ?, 'task.agent_run', ?)`,
      ).run(
        "act_aw4_linked",
        projectId,
        taskId,
        JSON.stringify({
          runId: "run_aw4_linked",
          status: "succeeded",
          link: "/agents/runs/run_aw4_linked",
          checksPassed: 1,
          checksFailed: 0,
          verdict: "approve",
        }),
      );
    });

    const page = await newPage();
    try {
      // The run page names the task it belongs to.
      await page.goto(`${baseURL}/agents/runs/run_aw4_linked`);
      await page.getByText("Do the linked work").first().waitFor();

      // No page renders task activity yet, so the entry is read through the task activity API.
      const res = await page.request.get(`${baseURL}/api/tasks/${taskId}/activity`);
      assert.equal(res.status(), 200, await res.text());
      const body = (await res.json()) as { events: Array<{ type: string; details: unknown }> };
      const entry = body.events.find((e) => e.type === "task.agent_run");
      assert.ok(entry, "the task has a task.agent_run entry");
      const details = (typeof entry.details === "string" ? JSON.parse(entry.details) : entry.details) as Record<
        string,
        unknown
      >;
      assert.equal(details["runId"], "run_aw4_linked");
      assert.equal(details["status"], "succeeded");
      assert.equal(details["checksPassed"], 1);
      assert.equal(details["checksFailed"], 0);
      assert.equal(details["verdict"], "approve");

      const taskRow = withDb((db) =>
        db.prepare("SELECT status, title FROM tasks WHERE id = ?").get(taskId),
      ) as { status: string; title: string };
      assert.equal(taskRow.status, "todo");
      assert.equal(taskRow.title, "Linked task for a run");

      assert.deepEqual(pageErrors(page), []);
    } finally {
      await page.context().close();
    }
  });

  it("approvals card: delete-worktree preview and reject, empty merge branch, unfinished run", async () => {
    const wt = addWorktree("aaaaaaaaaaaa", "aaaaaaaaaaaa");
    const baseRef = git(repoPath, ["rev-parse", "HEAD"]).trim();
    withDb((db) => {
      seedRun(db, {
        id: "run_aw4_approvals",
        task: "Finished run with a worktree",
        branch: wt.branch,
        workspacePath: wt.dir,
        baseRef,
      });
      seedRun(db, { id: "run_aw4_unfinished", task: "Run still going", status: "reviewing" });
    });

    const page = await newPage();
    try {
      await page.goto(`${baseURL}/agents/runs/run_aw4_approvals`);
      const select = page.locator("#approval-kind-select");
      await select.waitFor();

      // Merge with no branch: the required field error, nothing requested.
      await page.getByRole("button", { name: "Preview", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "Enter the branch to merge into" }).waitFor();

      // Delete worktree: preview lines, then reject.
      await select.selectOption("delete_worktree");
      await page.getByRole("button", { name: "Preview", exact: true }).click();
      await page.getByText(/Deletes .*; the branch agent\/aaaaaaaaaaaa is kept/).waitFor();
      await page.getByText("0 unmerged commits").waitFor();
      await page.getByRole("button", { name: "Reject Delete worktree" }).click();
      await page.getByText("Rejected", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Approve Delete worktree" }).count(), 0);
      // Rejecting never touches the worktree.
      assert.ok(fs.existsSync(wt.dir));

      await page.goto(`${baseURL}/agents/runs/run_aw4_unfinished`);
      await page.getByText("Actions unlock when the run finishes.").waitFor();
      assert.equal(await page.locator("#approval-kind-select").count(), 0);

      assert.deepEqual(pageErrors(page), []);
    } finally {
      await page.context().close();
    }
  });

  it("resume is offered for an interrupted run only and refuses a missing worktree in red", async () => {
    withDb((db) => {
      seedRun(db, {
        id: "run_aw4_interrupted",
        task: "Interrupted run",
        status: "interrupted",
        branch: "agent/bbbbbbbbbbbb",
        workspacePath: path.join(wtRoot, "command-center", "gone-folder"),
      });
      seedRun(db, { id: "run_aw4_done", task: "Succeeded run", status: "succeeded" });
    });

    const page = await newPage();
    try {
      await page.goto(`${baseURL}/agents/runs/run_aw4_done`);
      await page.getByText("succeeded", { exact: true }).first().waitFor();
      assert.equal(await page.getByRole("button", { name: "Resume" }).count(), 0);

      await page.goto(`${baseURL}/agents/runs/run_aw4_interrupted`);
      const resume = page.getByRole("button", { name: "Resume" });
      await resume.waitFor();
      // An interrupted run has ended, so there is nothing left to stop.
      assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).count(), 0);

      await resume.click();
      const alert = page.getByRole("alert").filter({ hasText: "no longer exists" });
      await alert.waitFor();
      assert.match(await alert.innerText(), /cannot be resumed/);
      assert.match((await alert.getAttribute("class")) ?? "", /text-red-/, "refusal is styled red");

      assert.deepEqual(pageErrors(page), []);
    } finally {
      await page.context().close();
    }
  });

  it("dismisses a finished run, lists it under Show dismissed and restores it", async () => {
    const task = "Dismissible finished run";
    withDb((db) => seedRun(db, { id: "run_aw4_dismiss", task }));

    const page = await newPage();
    try {
      await page.goto(`${baseURL}/agents`);
      await page.getByRole("link", { name: task }).waitFor();

      await page.getByRole("link", { name: task }).click();
      await page.waitForURL("**/agents/runs/run_aw4_dismiss");
      await page.getByRole("button", { name: "Dismiss", exact: true }).click();
      await page.getByRole("button", { name: "Restore", exact: true }).waitFor();

      await page.goto(`${baseURL}/agents`);
      await page.getByRole("link", { name: "Show dismissed" }).waitFor();
      assert.equal(await page.getByRole("link", { name: task }).count(), 0);

      await page.getByRole("link", { name: "Show dismissed" }).click();
      await page.waitForURL("**/agents?dismissed=1");
      await page.getByRole("link", { name: task }).waitFor();

      await page.getByRole("link", { name: task }).click();
      await page.getByRole("button", { name: "Restore", exact: true }).click();
      await page.getByRole("button", { name: "Dismiss", exact: true }).waitFor();

      await page.goto(`${baseURL}/agents`);
      await page.getByRole("link", { name: task }).waitFor();

      assert.deepEqual(pageErrors(page), []);
    } finally {
      await page.context().close();
    }
  });

  it("worktree cleanup setting persists, validates its range and previews without deleting", async () => {
    const wt = addWorktree("cccccccccccc", "cccccccccccc");
    const baseRef = git(repoPath, ["rev-parse", "HEAD"]).trim();
    withDb((db) =>
      seedRun(db, {
        id: "run_aw4_old_dismissed",
        task: "Old dismissed run",
        branch: wt.branch,
        workspacePath: wt.dir,
        baseRef,
        dismissedAt: new Date(Date.now() - 30 * DAY_MS).toISOString(),
      }),
    );

    const page = await newPage();
    try {
      await page.goto(`${baseURL}/settings/agents`);
      const input = page.getByLabel("Remove worktrees of dismissed runs after this many days");
      await input.waitFor();
      const save = page.locator("form").filter({ has: input }).getByRole("button", { name: "Save", exact: true });
      assert.equal(await input.inputValue(), "", "cleanup is off by default");

      // Off: the preview says nothing would be removed.
      await page.getByRole("button", { name: "Preview cleanup" }).click();
      await page.getByText("Cleanup is off, so nothing would be removed.").waitFor();

      await input.fill("7");
      await save.click();
      await page.getByText("Saved.", { exact: true }).waitFor();

      await page.reload();
      assert.equal(
        await page.getByLabel("Remove worktrees of dismissed runs after this many days").inputValue(),
        "7",
      );

      for (const bad of ["0", "366"]) {
        const field = page.getByLabel("Remove worktrees of dismissed runs after this many days");
        await field.fill(bad);
        await save.click();
        await page.getByText("Enter a whole number of days from 1 to 365").waitFor();
      }
      // The failed saves did not change the stored value.
      await page.reload();
      assert.equal(
        await page.getByLabel("Remove worktrees of dismissed runs after this many days").inputValue(),
        "7",
      );

      await page.getByRole("button", { name: "Preview cleanup" }).click();
      const entry = page.getByRole("listitem").filter({ hasText: "run_aw4_old_dismissed" });
      await entry.waitFor();
      await entry.getByText("Would remove").waitFor();

      // Previewing removes nothing.
      assert.ok(fs.existsSync(wt.dir), "the worktree folder still exists");
      assert.ok(fs.existsSync(path.join(wt.dir, "README.md")));
      assert.match(git(repoPath, ["branch", "--list", wt.branch]), /agent\/cccccccccccc/);

      assert.deepEqual(pageErrors(page), []);
    } finally {
      await page.context().close();
    }
  });
});

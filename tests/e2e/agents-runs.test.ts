/**
 * Agent pages — genuine browser interaction (Chromium, production build,
 * desktop/SQLite server).
 *
 * The runner process is not running here, so finished runs and their event logs
 * are written straight into the throwaway database, in the shapes the
 * orchestrator records.
 *
 * 1. Multi-round run page: round switcher, plan card, per-round findings, and
 *    the comment form being read-only on older rounds.
 * 2. Legacy run (no `round` on events): no switcher, diff and review still render.
 * 3. /agents lists a Codex provider row.
 * 4. The implementer select does not offer Codex.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { Page } from "playwright";
import { baseURL, e2eDatabasePath, newPage, pageErrors, start, stop } from "./helpers";

let seedPage: Page;
let projectId = "";

const MULTI_ID = "run_e2e_multi";
const LEGACY_ID = "run_e2e_legacy";
const MULTI_TASK = "Add a retry wrapper to the sync client";
const LEGACY_TASK = "Fix the legacy date parser";

type Seed = { agent: string; kind: string; stage: string | null; payload: unknown };

function seedRun(db: Database.Database, id: string, task: string, events: Seed[]): void {
  const request = { projectId, task, checks: [], roles: { implementer: { provider: "claude-code" } } };
  db.prepare(
    `INSERT INTO agent_run (id, project_id, status, stage, request, outcome, ended_at)
     VALUES (?, ?, 'succeeded', 'final', ?, ?, datetime('now'))`,
  ).run(id, projectId, JSON.stringify(request), JSON.stringify({ status: "succeeded" }));
  const insert = db.prepare(
    "INSERT INTO agent_run_event (run_id, seq, stage, agent, kind, payload) VALUES (?, ?, ?, ?, ?, ?)",
  );
  events.forEach((e, i) => insert.run(id, i + 1, e.stage, e.agent, e.kind, JSON.stringify(e.payload)));
}

const diffEvent = (path: string, round?: number): Seed => ({
  agent: "system",
  kind: "diff_summary",
  stage: "diff",
  payload: {
    files: [{ path, status: "modified", additions: 3, deletions: 1, binary: false, outOfScope: false, excluded: false }],
    totals: { files: 1, additions: 3, deletions: 1 },
    ...(round === undefined ? {} : { round }),
  },
});

const checkEvent = (round?: number): Seed => ({
  agent: "checks",
  kind: "check_result",
  stage: "checks",
  payload: {
    name: "unit",
    exitCode: 0,
    timedOut: false,
    durationMs: 1200,
    output: "ok",
    ...(round === undefined ? {} : { round }),
  },
});

before(async () => {
  await start();
  seedPage = await newPage();
  const res = await seedPage.request.post(`${baseURL}/api/projects`, {
    data: { source: "manual", type: "software", status: "active", name: "Agent e2e project" },
  });
  assert.equal(res.status(), 201, await res.text());
  projectId = ((await res.json()) as { project: { id: string } }).project.id;

  const db = new Database(e2eDatabasePath());
  try {
    db.prepare("UPDATE projects SET local_path = ? WHERE id = ?").run(process.cwd(), projectId);
    seedRun(db, MULTI_ID, MULTI_TASK, [
      {
        agent: "planner",
        kind: "output",
        stage: "plan",
        payload: {
          kind: "plan",
          plan: {
            task: MULTI_TASK,
            scope_paths: ["src/sync/client.ts"],
            acceptance: ["Retries three times"],
            checks: ["unit"],
          },
          round: 0,
        },
      },
      diffEvent("src/sync/client.ts", 0),
      checkEvent(0),
      {
        agent: "reviewer",
        kind: "review",
        stage: "review",
        payload: {
          verdict: "request_changes",
          summary: "One blocking issue",
          findings: [
            { severity: "P1", path: "src/sync/client.ts", line: 10, message: "Retry loop never backs off", actionable: true },
            { severity: "P3", path: "src/sync/client.ts", line: 40, message: "Rename the helper", actionable: false },
          ],
          round: 0,
        },
      },
      diffEvent("src/sync/client.ts", 1),
      checkEvent(1),
      {
        agent: "reviewer",
        kind: "review",
        stage: "review",
        payload: { verdict: "approve", summary: "Looks good", findings: [], round: 1 },
      },
    ]);
    seedRun(db, LEGACY_ID, LEGACY_TASK, [
      diffEvent("src/legacy/date.ts"),
      checkEvent(),
      {
        agent: "reviewer",
        kind: "review",
        stage: "review",
        payload: {
          verdict: "request_changes",
          summary: "s",
          findings: [{ severity: "P2", path: "src/legacy/date.ts", line: 3, message: "Handle empty input", actionable: true }],
        },
      },
    ]);
  } finally {
    db.close();
  }
});

after(async () => stop());

describe("agent pages (real browser)", () => {
  it("multi-round run: switcher, plan card, per-round findings, read-only comments on old rounds", async () => {
    const p = await newPage();
    await p.goto(`/agents/runs/${MULTI_ID}`, { waitUntil: "domcontentloaded" });

    const initial = p.getByRole("button", { name: "Initial", exact: true });
    const round1 = p.getByRole("button", { name: "Round 1", exact: true });
    await round1.waitFor();
    await initial.waitFor();
    assert.equal(await round1.getAttribute("aria-pressed"), "true", "defaults to the latest round");
    assert.equal(await initial.getAttribute("aria-pressed"), "false");

    // Plan card.
    await p.getByRole("heading", { name: "Plan" }).waitFor();
    await p.getByText(MULTI_TASK).last().waitFor();
    await p.getByText("src/sync/client.ts", { exact: true }).first().waitFor();

    // Round 1: approve, add form present.
    await p.getByText("No findings.").waitFor();
    await p.getByLabel("Comment", { exact: true }).waitFor();
    assert.equal(await p.getByText("Comments are picked up for the latest round only").count(), 0);

    // Initial: grouped findings, read-only comments.
    await initial.click();
    assert.equal(await initial.getAttribute("aria-pressed"), "true");
    const blocking = p.getByRole("heading", { level: 3 }).filter({ hasText: "blocking" });
    const minor = p.getByRole("heading", { level: 3 }).filter({ hasText: "minor" });
    await blocking.waitFor();
    assert.match((await blocking.textContent()) ?? "", /blocking\s*1/i);
    assert.match((await minor.textContent()) ?? "", /minor\s*1/i);
    await p.getByRole("listitem").filter({ hasText: "Retry loop never backs off" }).waitFor();
    assert.equal(await p.getByText("actionable", { exact: true }).count(), 1, "only the P1 is actionable");
    await p.getByText("Comments are picked up for the latest round only. Switch to Round 1 to add one.").waitFor();
    assert.equal(await p.getByLabel("Comment", { exact: true }).count(), 0, "no add form on an older round");

    // Back to Round 1: form returns.
    await round1.click();
    await p.getByLabel("Comment", { exact: true }).waitFor();
    assert.deepEqual(pageErrors(p), []);
    await p.context().close();
  });

  it("legacy run: no round switcher; diff and review render", async () => {
    const p = await newPage();
    await p.goto(`/agents/runs/${LEGACY_ID}`, { waitUntil: "domcontentloaded" });
    await p.getByRole("listitem").filter({ hasText: "Handle empty input" }).waitFor();
    await p.getByText("src/legacy/date.ts").first().waitFor();
    assert.equal(await p.getByRole("group", { name: "Round" }).count(), 0);
    assert.equal(await p.getByRole("button", { name: "Initial", exact: true }).count(), 0);
    assert.equal(await p.getByRole("heading", { name: "Plan" }).count(), 0);
    await p.getByRole("heading", { level: 3 }).filter({ hasText: "major" }).waitFor();
    assert.deepEqual(pageErrors(p), []);
    await p.context().close();
  });

  it("/agents lists a Codex provider row and the run history", async () => {
    const p = await newPage();
    await p.goto("/agents", { waitUntil: "domcontentloaded" });
    await p.getByRole("heading", { name: "Agents" }).waitFor();
    // Not asserting installed or signed in: that depends on the machine.
    await p.getByRole("option", { name: /Codex/ }).first().waitFor({ state: "attached" });
    await p.getByRole("link", { name: MULTI_TASK }).waitFor();
    await p.getByRole("link", { name: LEGACY_TASK }).waitFor();
    assert.deepEqual(pageErrors(p), []);
    await p.context().close();
  });

  it("run form: the implementer select does not offer Codex", async () => {
    const p = await newPage();
    await p.goto("/agents", { waitUntil: "domcontentloaded" });
    // Field labels are plain spans (not <label for>), so find the select next to the text.
    const implementer = p.locator(
      "xpath=//span[normalize-space()='Implementer']/parent::div/following-sibling::select",
    );
    await implementer.waitFor();
    const labels = await implementer.locator("option").allTextContents();
    assert.ok(labels.length > 0, "implementer select has options");
    assert.ok(labels.some((l) => /Claude/i.test(l)), `offers Claude: ${labels.join(" | ")}`);
    assert.ok(!labels.some((l) => /Codex/i.test(l)), `must not offer Codex: ${labels.join(" | ")}`);
    await p.context().close();
  });
});

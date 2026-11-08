/**
 * Unit tests for the optional LM Studio advisor in the orchestrator (AW3-06b)
 * and the run form's planner/reviewer provider filter.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db";
import { agentRuns, projects } from "../../src/db/schema";
import { readSince } from "../../src/core/agents/events";
import { fakeAdapter } from "../../src/core/agents/adapters/fake";
import { spawnAgentProcess, stopAgentProcess } from "../../src/core/agents/process";
import { runAgentRun, type OrchestratorDeps, type RunOutcome, type RunPolicy } from "../../src/core/agents/orchestrator";
import type { AdvisorFacts, AdvisorResult } from "../../src/core/agents/adapters/lmstudio";
import { advisorFromEnv } from "../../src/core/agents/advisor";
import { implementerProviders, reviewRoleProviders } from "../../src/components/agents/runs/role-defaults";

let db: typeof import("../../src/db/client").db;
const tempDirs: string[] = [];
let counter = 0;

before(async () => {
  await migrate();
  ({ db } = await import("../../src/db/client"));
  db.insert(projects).values({ id: "prj-adv", name: "Advisor" }).run();
});
after(async () => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  await cleanup();
});

const POLICY: RunPolicy = { checks: [{ name: "lint", argv: ["npm", "run", "lint"] }], excludedPaths: [] };

function setup(overrides: Partial<OrchestratorDeps>, reviewVerdict = "approve") {
  const runId = `run-adv-${++counter}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adv test "));
  tempDirs.push(root);
  const runStore = path.join(root, "store");
  const worktreeRoot = path.join(root, "wt");
  fs.mkdirSync(path.join(runStore, "runs"), { recursive: true });
  fs.mkdirSync(worktreeRoot, { recursive: true });
  const request = {
    projectId: "prj-adv",
    task: "do the thing",
    roles: { implementer: { provider: "fake", model: "success" } },
    checks: ["lint"],
  };
  db.insert(agentRuns).values({ id: runId, projectId: "prj-adv", request: JSON.stringify(request) }).run();
  const controller = new AbortController();
  const wt = (r: string) => path.join(worktreeRoot, r);
  const deps: OrchestratorDeps = {
    db,
    implementer: fakeAdapter,
    review: async () => ({ verdict: reviewVerdict, findings: [] }),
    workspace: {
      create: async ({ runId: r }) => {
        fs.mkdirSync(wt(r), { recursive: true });
        return { path: wt(r), branch: `agent/${r}`, baseSha: "a".repeat(40) };
      },
      commit: async () => "b".repeat(40),
      diff: async () => ({
        files: [
          { path: "fake-output.txt", status: "added", additions: 1, deletions: 0, binary: false, outOfScope: false, excluded: false },
        ],
        totals: { files: 1, additions: 1, deletions: 0 },
      }),
      patch: async () => ({ files: [], truncated: false }),
      pathFor: (_r, r) => wt(r),
      shortId: (r) => r.slice(-6),
    },
    spawn: (o) => spawnAgentProcess(o),
    stop: (h, o) => stopAgentProcess(h, o),
    runCheck: async (check) => ({ name: check.name, exitCode: 0, timedOut: false, durationMs: 1, output: "ok" }),
    storage: { worktreeRoot, runStore },
    signal: controller.signal,
    ...overrides,
  };
  const run = (): Promise<RunOutcome> =>
    runAgentRun(deps, { runId, repoPath: path.join(root, "repo"), policy: POLICY });
  return { runId, run, controller };
}

const advisorEvents = async (runId: string) =>
  (await readSince(db, runId, 0, 1000)).filter((e) => e.kind === "advisor");

describe("orchestrator advisor (AW3-06b)", () => {
  it("ok result: one advisor event, outcome unchanged", { timeout: 30_000 }, async () => {
    let seen: AdvisorFacts | undefined;
    const result: AdvisorResult = { ok: true, model: "m", summary: "- fine" };
    const baseline = await setup({}).run();
    const t = setup({
      advisor: async (facts) => {
        seen = facts;
        return result;
      },
    });
    const outcome = await t.run();
    assert.deepEqual(outcome, baseline);
    const evs = await advisorEvents(t.runId);
    assert.equal(evs.length, 1);
    assert.equal(evs[0]!.agent, "advisor");
    assert.deepEqual(evs[0]!.payload, result);
    assert.deepEqual(seen, {
      task: "do the thing",
      status: "succeeded",
      reviewVerdict: "approve",
      rounds: 0,
      filesChanged: ["fake-output.txt"],
      checks: [{ name: "lint", passed: true }],
      findings: [],
    });
  });

  it("failed run also gets advice, still failed", { timeout: 30_000 }, async () => {
    const t = setup({ advisor: async () => ({ ok: true, model: "m", summary: "s" }) }, "request_changes");
    const outcome = await t.run();
    assert.equal(outcome.status, "failed");
    assert.equal((await advisorEvents(t.runId)).length, 1);
  });

  it("throw leaves the outcome alone and records nothing", { timeout: 30_000 }, async () => {
    const t = setup({
      advisor: async () => {
        throw new Error("boom");
      },
    });
    const outcome = await t.run();
    assert.equal(outcome.status, "succeeded");
    assert.equal((await advisorEvents(t.runId)).length, 0);
  });

  it("ok:false is recorded, outcome unchanged", { timeout: 30_000 }, async () => {
    const t = setup({ advisor: async () => ({ ok: false, reason: "no model loaded in LM Studio" }) });
    const outcome = await t.run();
    assert.equal(outcome.status, "succeeded");
    const evs = await advisorEvents(t.runId);
    assert.deepEqual(evs[0]!.payload, { ok: false, reason: "no model loaded in LM Studio" });
  });

  it("a hung advisor times out without holding the run", { timeout: 30_000 }, async () => {
    const t = setup({ advisor: () => new Promise<AdvisorResult>(() => {}), advisorTimeoutMs: 50 });
    const outcome = await t.run();
    assert.equal(outcome.status, "succeeded");
    const evs = await advisorEvents(t.runId);
    assert.equal(evs.length, 1);
    assert.equal((evs[0]!.payload as { ok: boolean }).ok, false);
  });

  it("owner stop: advisor not called", { timeout: 30_000 }, async () => {
    let called = 0;
    const holder: { controller?: AbortController } = {};
    const t = setup({
      advisor: async () => {
        called++;
        return { ok: true, model: "m", summary: "s" };
      },
      review: async () => {
        holder.controller?.abort();
        return { verdict: "approve", findings: [] };
      },
    });
    holder.controller = t.controller;
    const outcome = await t.run();
    assert.equal(outcome.status, "stopped");
    assert.equal(called, 0);
    assert.equal((await advisorEvents(t.runId)).length, 0);
  });
});

describe("advisorFromEnv", () => {
  it("is off unless DASHBOARD_ADVISOR=1", () => {
    assert.equal(advisorFromEnv({}), undefined);
    assert.equal(advisorFromEnv({ DASHBOARD_ADVISOR: "0" }), undefined);
  });
  it("uses the default and custom endpoint", async () => {
    const urls: Array<string | undefined> = [];
    const fake = (async (_f: AdvisorFacts, o?: { endpoint?: string }) => {
      urls.push(o?.endpoint);
      return { ok: false, reason: "x" };
    }) as never;
    const signal = new AbortController().signal;
    await advisorFromEnv({ DASHBOARD_ADVISOR: "1" }, fake)!({} as AdvisorFacts, signal);
    await advisorFromEnv({ DASHBOARD_ADVISOR: "1", DASHBOARD_ADVISOR_URL: "http://h:9" }, fake)!({} as AdvisorFacts, signal);
    assert.deepEqual(urls, ["http://127.0.0.1:1234", "http://h:9"]);
  });
});

describe("run form provider selects", () => {
  const providers = [{ id: "claude-code" }, { id: "codex" }, { id: "antigravity" }];
  it("planner/reviewer exclude antigravity, implementer keeps it", () => {
    assert.deepEqual(reviewRoleProviders(providers).map((p) => p.id), ["claude-code", "codex"]);
    assert.ok(implementerProviders(providers).some((p) => p.id === "antigravity"));
  });
});

/**
 * Excluded paths are enforced three ways (AW4-04): Claude Code deny rules, the
 * Antigravity tool monitor, and the post-stage diff check. A policy excluding
 * `secret/**` must show up in all three.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db";
import { agentRuns, projects } from "../../src/db/schema";
import { readSince } from "../../src/core/agents/events";
import { antigravityAdapter, buildAntigravityInvocation } from "../../src/core/agents/adapters/antigravity";
import { buildClaudeInvocation } from "../../src/core/agents/adapters/claude-code";
import type { AgentAdapter } from "../../src/core/agents/adapters/types";
import type { AgentExit, AgentProcessHandle } from "../../src/core/agents/process";
import { runAgentRun, type OrchestratorDeps, type RunPolicy } from "../../src/core/agents/orchestrator";
import { describeViolation } from "../../src/core/agents/tool-monitor";
import { matchGlob, type DiffSummaryResult } from "../../src/core/agents/workspace";

let db: typeof import("../../src/db/client").db;
const tempDirs: string[] = [];
let counter = 0;

before(async () => {
  await migrate();
  ({ db } = await import("../../src/db/client"));
  db.insert(projects).values({ id: "prj-excl", name: "Exclusions" }).run();
});

after(async () => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  await cleanup();
});

const EXCLUDED = ["secret/**"];
const POLICY: RunPolicy = { checks: [{ name: "lint", argv: ["npm", "run", "lint"] }], excludedPaths: EXCLUDED };
const CONV = "b7c2ebcb-7376-4e3f-acbc-12a7551f5376";

const fakeAgy: AgentAdapter = {
  ...antigravityAdapter,
  buildInvocation: (req) => buildAntigravityInvocation(req, { executableFile: "agy-fake" }),
};

const toolStep = (index: number, state: string, toolName: string, parameters: Record<string, unknown>) => ({
  event: "step_update",
  step_update: {
    conversation_id: CONV,
    step_index: index,
    state,
    step_type: "tool",
    tool_name: toolName,
    tool_info: { name: toolName, parameters },
  },
});
const init = { event: "init", conversation_id: CONV, init: { model: "m", cwd: "x" } };
const result = {
  event: "result",
  result: { conversation_id: CONV, status: "SUCCESS", response: "ok", num_turns: 1 },
};

/** A diff whose `excluded` flags come from the real glob matcher, like diffSummary does. */
function diffOf(...paths: string[]): DiffSummaryResult {
  return {
    files: paths.map((p) => ({
      path: p,
      status: "added" as const,
      additions: 1,
      deletions: 0,
      binary: false,
      outOfScope: false,
      excluded: EXCLUDED.some((g) => matchGlob(g, p)),
    })),
    totals: { files: paths.length, additions: paths.length, deletions: 0 },
  };
}

interface Env {
  runId: string;
  root: string;
  worktree: string;
  deps: OrchestratorDeps;
  stops: number;
}

function makeEnv(lines: unknown[], hang: boolean, diff: DiffSummaryResult): Env {
  const runId = `run-excl-${++counter}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "excl test "));
  tempDirs.push(root);
  const runStore = path.join(root, "run store");
  const worktreeRoot = path.join(root, "work trees");
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(runStore, "runs"), { recursive: true });
  fs.mkdirSync(worktreeRoot, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const worktree = path.join(worktreeRoot, runId);
  const request = {
    projectId: "prj-excl",
    task: "write something",
    roles: { implementer: { provider: fakeAgy.id } },
    checks: ["lint"],
  };
  db.insert(agentRuns).values({ id: runId, projectId: "prj-excl", request: JSON.stringify(request) }).run();

  const env = { runId, root, worktree, stops: 0 } as Env;
  const controller = new AbortController();
  env.deps = {
    db,
    stopGraceMs: 50,
    implementer: fakeAgy,
    monitorOptions: { home },
    review: async () => ({ verdict: "approve", findings: [] }),
    workspace: {
      create: async () => {
        fs.mkdirSync(worktree, { recursive: true });
        return { path: worktree, branch: `agent/${runId}`, baseSha: "a".repeat(40) };
      },
      commit: async () => "b".repeat(40),
      diff: async () => diff,
      patch: async () => ({ files: [], truncated: false }),
      pathFor: (_root, r) => path.join(worktreeRoot, r),
      shortId: (r) => r.slice(-6),
    },
    spawn: (o) => {
      let stopped = false;
      let release: () => void = () => {};
      const stoppedSignal = new Promise<void>((r) => (release = r));
      let resolveDone: (e: AgentExit) => void = () => {};
      const done = new Promise<AgentExit>((r) => (resolveDone = r));
      const handle = {
        pid: undefined,
        pgid: undefined,
        platform: process.platform,
        done,
        stopRequested: false,
        exited: false,
      } as unknown as AgentProcessHandle;
      (handle as unknown as { __stop: () => void }).__stop = () => {
        stopped = true;
        handle.stopRequested = true;
        release();
      };
      void (async () => {
        for (const line of lines) {
          await new Promise((r) => setImmediate(r));
          if (stopped) break;
          o.onJson?.(line);
        }
        if (hang && !stopped) {
          await Promise.race([stoppedSignal, new Promise((r) => setTimeout(r, 5000))]);
        }
        handle.exited = true;
        resolveDone(
          stopped
            ? { code: null, signal: "SIGTERM", stoppedByUs: true }
            : { code: 0, signal: null, stoppedByUs: false },
        );
      })();
      return handle;
    },
    stop: async (h) => {
      env.stops++;
      (h as unknown as { __stop: () => void }).__stop();
      return h.done;
    },
    runCheck: async (c) => ({ name: c.name, exitCode: 0, timedOut: false, durationMs: 1, output: "ok" }),
    storage: { worktreeRoot, runStore },
    signal: controller.signal,
  };
  return env;
}

const run = (env: Env) =>
  runAgentRun(env.deps, { runId: env.runId, repoPath: path.join(env.root, "repo"), policy: POLICY });

describe("excluded paths are enforced three ways (AW4-04)", () => {
  it("a. Claude Code: the settings grant carries deny rules for the excluded glob", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "excl claude "));
    tempDirs.push(tempRoot);
    const workspacePath = path.join(tempRoot, "workspace");
    const grantDir = path.join(tempRoot, "grants");
    fs.mkdirSync(workspacePath, { recursive: true });
    const inv = buildClaudeInvocation(
      {
        workspacePath,
        prompt: "p",
        model: "m",
        effort: "medium",
        checkCommands: [["npm", "test"]],
        excludedPaths: EXCLUDED,
        grantDir,
      },
      { executableFile: path.join(os.tmpdir(), "fake-claude-bin", "claude") },
    );
    const settingsArg = inv.args[inv.args.indexOf("--settings") + 1];
    assert.equal(settingsArg, path.join(grantDir, "claude-settings.json"));
    const grant = JSON.parse(fs.readFileSync(settingsArg!, "utf8")) as { permissions: { deny: string[] } };
    for (const tool of ["Read", "Edit", "Write"]) {
      assert.ok(grant.permissions.deny.includes(`${tool}(secret/**)`), tool);
    }
  });

  it("b. Antigravity: a write to secret/x is stopped by the monitor with the excluded-path reason", { timeout: 30_000 }, async () => {
    const env = makeEnv(
      [init, toolStep(1, "ACTIVE", "write_to_file", { TargetFile: "secret/x", CodeContent: "k" }), result],
      true,
      diffOf("hello.txt"),
    );
    const outcome = await run(env);
    assert.equal(outcome.status, "failed");
    const expected = describeViolation({
      allowed: false,
      tool: "write_to_file",
      reason: "excluded path secret/x",
    });
    assert.deepEqual(outcome.missing, [expected]);
    assert.match(expected, /excluded path secret\/x/);
    assert.equal(env.stops, 1, "killed once");
    const evs = await readSince(db, env.runId, 0, 1000);
    const stops = evs.filter((e) => e.kind === "monitor_stop");
    assert.equal(stops.length, 1);
    assert.equal((stops[0]!.payload as { message: string }).message, expected);
  });

  it("b2. Antigravity: reading secret/x is not a violation", { timeout: 30_000 }, async () => {
    const env = makeEnv(
      [init, toolStep(1, "ACTIVE", "view_file", { AbsolutePath: "secret/x" }), result],
      false,
      diffOf("hello.txt"),
    );
    const outcome = await run(env);
    assert.equal(outcome.status, "succeeded", JSON.stringify(outcome.missing));
    assert.equal(env.stops, 0);
  });

  it("c. a diff touching secret/x fails the run with excludedTouched", { timeout: 30_000 }, async () => {
    const env = makeEnv([init, result], false, diffOf("src/a.ts", "secret/x"));
    const outcome = await run(env);
    assert.equal(outcome.status, "failed");
    assert.deepEqual(outcome.facts.excludedTouched, ["secret/x"]);
    assert.deepEqual(outcome.missing, ["excluded paths changed: secret/x"]);
  });
});

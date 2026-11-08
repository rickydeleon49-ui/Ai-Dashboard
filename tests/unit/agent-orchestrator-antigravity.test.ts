/**
 * Orchestrator tests for the Antigravity implementer (Release AW.3, AW3-04).
 *
 * No real agy: spawn is a fake that replays (and rewrites) the recorded agy
 * stream fixtures. Covers the tool monitor, the monitor-stop failure reason,
 * the two-continuation rule and the Antigravity-only prompt preamble.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db";
import { agentRuns, projects } from "../../src/db/schema";
import { readSince, type StoredAgentEvent } from "../../src/core/agents/events";
import { antigravityAdapter, buildAntigravityInvocation } from "../../src/core/agents/adapters/antigravity";
import type { AgentAdapter } from "../../src/core/agents/adapters/types";
import type { AgentExit, AgentProcessHandle, SpawnAgentOptions } from "../../src/core/agents/process";
import {
  runAgentRun,
  type OrchestratorDeps,
  type RunOutcome,
  type RunPolicy,
} from "../../src/core/agents/orchestrator";
import { describeViolation } from "../../src/core/agents/tool-monitor";
import type { DiffSummaryResult } from "../../src/core/agents/workspace";

let db: typeof import("../../src/db/client").db;
const tempDirs: string[] = [];
let counter = 0;

before(async () => {
  await migrate();
  ({ db } = await import("../../src/db/client"));
  db.insert(projects).values({ id: "prj-agy", name: "Antigravity" }).run();
});

after(async () => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  await cleanup();
});

const POLICY: RunPolicy = { checks: [{ name: "lint", argv: ["npm", "run", "lint"] }], excludedPaths: [] };
const DIFF: DiffSummaryResult = {
  files: [{ path: "hello.txt", status: "added", additions: 1, deletions: 0, binary: false, outOfScope: false, excluded: false }],
  totals: { files: 1, additions: 1, deletions: 0 },
};
const CONV = "b7c2ebcb-7376-4e3f-acbc-12a7551f5376";

/** The adapter with a fixed executable so no real agy is needed. */
const fakeAgy: AgentAdapter = {
  ...antigravityAdapter,
  buildInvocation: (req) => buildAntigravityInvocation(req, { executableFile: "agy-fake" }),
};

/** One scripted spawn: the JSON lines to replay and how it ends. */
interface Script {
  lines: unknown[];
  code?: number;
  /** Keep running after the lines until stopped (a violation must kill it). */
  hang?: boolean;
}

function fixture(name: string): unknown[] {
  return fs
    .readFileSync(path.join(__dirname, "..", "fixtures", "agy", `${name}.jsonl`), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as unknown);
}

/** Rewrite every string in a value: recorded paths point at the machine that recorded them. */
function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return value;
}

const step = (index: number, state: string, toolName: string, parameters: Record<string, unknown>) => ({
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

interface Env {
  runId: string;
  root: string;
  home: string;
  worktree: string;
  deps: OrchestratorDeps;
  spawns: SpawnAgentOptions[];
  stops: number;
}

/** `scripts` may be a function of the env so fixtures can be rewritten to this test's paths. */
function makeEnv(scripts: Script[] | ((env: Env) => Script[]), implementer: AgentAdapter = fakeAgy): Env {
  const runId = `run-agy-${++counter}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy test "));
  tempDirs.push(root);
  const runStore = path.join(root, "run store");
  const worktreeRoot = path.join(root, "work trees");
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(runStore, "runs"), { recursive: true });
  fs.mkdirSync(worktreeRoot, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const worktree = path.join(worktreeRoot, runId);
  const request = {
    projectId: "prj-agy",
    task: "write hello.txt",
    roles: { implementer: { provider: implementer.id } },
    checks: ["lint"],
  };
  db.insert(agentRuns).values({ id: runId, projectId: "prj-agy", request: JSON.stringify(request) }).run();

  const env = { runId, root, home, worktree, spawns: [] as SpawnAgentOptions[], stops: 0 } as Env;
  const controller = new AbortController();
  env.deps = {
    db,
    stopGraceMs: 50,
    implementer,
    monitorOptions: { home },
    review: async () => ({ verdict: "approve", findings: [] }),
    workspace: {
      create: async () => {
        fs.mkdirSync(worktree, { recursive: true });
        return { path: worktree, branch: `agent/${runId}`, baseSha: "a".repeat(40) };
      },
      commit: async () => "b".repeat(40),
      diff: async () => DIFF,
      patch: async () => ({ files: [], truncated: false }),
      pathFor: (_root, r) => path.join(worktreeRoot, r),
      shortId: (r) => r.slice(-6),
    },
    spawn: (o) => {
      const list = typeof scripts === "function" ? scripts(env) : scripts;
      const script = list[env.spawns.length];
      assert.ok(script, `unexpected spawn #${env.spawns.length + 1}`);
      env.spawns.push(o);
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
        for (const line of script.lines) {
          await new Promise((r) => setImmediate(r));
          if (stopped) break;
          o.onJson?.(line);
        }
        if (script.hang && !stopped) {
          await Promise.race([stoppedSignal, new Promise((r) => setTimeout(r, 5000))]);
        }
        handle.exited = true;
        resolveDone(
          stopped
            ? { code: null, signal: "SIGTERM", stoppedByUs: true }
            : { code: script.code ?? 0, signal: null, stoppedByUs: false },
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

const run = (env: Env): Promise<RunOutcome> =>
  runAgentRun(env.deps, { runId: env.runId, repoPath: path.join(env.root, "repo"), policy: POLICY });
const events = (env: Env): Promise<StoredAgentEvent[]> => readSince(db, env.runId, 0, 1000);
const kinds = (evs: StoredAgentEvent[], kind: string) => evs.filter((e) => e.kind === kind);

/** A recorded fixture with its machine-specific paths pointed at this test's worktree and home. */
function replay(env: Env, name: string, recordedDir: string): unknown[] {
  return fixture(name).map((l) =>
    mapStrings(l, (s) => s.split(recordedDir).join(env.worktree).split("C:\\Users\\user").join(env.home)),
  );
}

describe("Antigravity implementer in the orchestrator (AW3-04)", () => {
  it("a. allowed file tools succeed; the SKILL.md read records plugin_read", { timeout: 30_000 }, async () => {
    const env = makeEnv((e) => [{ lines: replay(e, "t1", "H:\\agy-smoke-153\\t1") }]);
    const skill = path.join(env.home, ".gemini", "config", "plugins", "data-agent-kit-plugin", "skills", "dak-setup", "SKILL.md");
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, "skill");
    const outcome = await run(env);
    assert.equal(outcome.status, "succeeded", JSON.stringify(outcome.missing));
    const evs = await events(env);
    const reads = kinds(evs, "plugin_read");
    assert.equal(reads.length, 1, "one plugin_read for the SKILL.md read");
    assert.equal(reads[0]!.agent, "system");
    assert.equal(kinds(evs, "monitor_stop").length, 0);
    assert.equal(kinds(evs, "continuation").length, 0);
    assert.equal(env.stops, 0);
    // The prompt carries the Antigravity rules; the invocation is the fake executable.
    assert.equal(env.spawns.length, 1);
    assert.equal(env.spawns[0]!.file, "agy-fake");
    assert.ok(env.spawns[0]!.stdin?.includes("Use file tools only"), "preamble is in the prompt");
  });

  it("b. a run_command step is stopped once and fails the run with the violation text", { timeout: 30_000 }, async () => {
    const env = makeEnv((e) => [{ lines: replay(e, "t2", "H:\\agy-smoke-153\\t2"), hang: true }]);
    const outcome = await run(env);
    assert.equal(outcome.status, "failed");
    const expected = describeViolation({ allowed: false, tool: "run_command", reason: "tool not allowed" });
    assert.deepEqual(outcome.missing, [expected]);
    const evs = await events(env);
    const stops = kinds(evs, "monitor_stop");
    assert.equal(stops.length, 1);
    assert.equal((stops[0]!.payload as { message: string }).message, expected);
    assert.equal(env.stops, 1, "killed once");
    assert.equal(env.spawns.length, 1, "never continued");
    assert.equal(kinds(evs, "continuation").length, 0);
    // Nothing the agent said after the violation was recorded as a tool result.
    assert.equal(
      evs.filter((e) => e.kind === "tool_result" && (e.payload as { name?: string }).name === "run_command").length,
      0,
    );
    assert.equal(db.select().from(agentRuns).where(eq(agentRuns.id, env.runId)).get()?.status, "failed");
  });

  it("c. a read_file outside the worktree is stopped", { timeout: 30_000 }, async () => {
    const env = makeEnv((e) => {
      const outside = path.join(e.root, "outside.txt");
      fs.writeFileSync(outside, "x");
      return [{ lines: [init, step(3, "ACTIVE", "read_file", { Path: outside }), result], hang: true }];
    });
    const outcome = await run(env);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.missing.length, 1);
    assert.match(outcome.missing[0]!, /outside worktree/);
    const evs = await events(env);
    assert.equal(kinds(evs, "monitor_stop").length, 1);
    assert.equal(env.stops, 1);
    assert.equal(env.spawns.length, 1);
    assert.equal(kinds(evs, "continuation").length, 0);
  });

  it("d. exit without a result is continued twice with --conversation, then fails with the count", { timeout: 30_000 }, async () => {
    const lines = [init];
    const env = makeEnv([{ lines, code: 1 }, { lines, code: 1 }, { lines, code: 1 }]);
    const outcome = await run(env);
    assert.equal(outcome.status, "failed");
    assert.equal(env.spawns.length, 3, "first spawn plus two continuations");
    assert.equal(env.spawns[0]!.args.includes("--conversation"), false);
    for (const s of env.spawns.slice(1)) {
      const i = s.args.indexOf("--conversation");
      assert.ok(i >= 0, "continuation resumes the conversation");
      assert.equal(s.args[i + 1], CONV);
    }
    const evs = await events(env);
    const conts = kinds(evs, "continuation").map((e) => e.payload as { attempt: number; of: number; stage: string });
    assert.deepEqual(conts.map((c) => c.attempt), [1, 2]);
    assert.ok(conts.every((c) => c.of === 2 && c.stage === "implement"));
    assert.equal(outcome.missing.length, 1);
    assert.match(outcome.missing[0]!, /implement stage/);
    assert.match(outcome.missing[0]!, /2 of 2 continuation attempts/);
  });

  it("d2. a continuation that finishes lets the run succeed", { timeout: 30_000 }, async () => {
    const env = makeEnv([{ lines: [init], code: 1 }, { lines: [init, result] }]);
    const outcome = await run(env);
    assert.equal(outcome.status, "succeeded", JSON.stringify(outcome.missing));
    assert.equal(env.spawns.length, 2);
    assert.equal(kinds(await events(env), "continuation").length, 1);
  });

  it("d3. a CLI error status is not continued", { timeout: 30_000 }, async () => {
    const bad = { event: "result", result: { conversation_id: CONV, status: "ERROR", response: "" } };
    const env = makeEnv([{ lines: [init, bad], code: 1 }]);
    const outcome = await run(env);
    assert.equal(outcome.status, "failed");
    assert.equal(env.spawns.length, 1);
    assert.match(outcome.missing[0]!, /Antigravity failed/);
  });

  it("e. a non-Antigravity implementer gets no monitor and no preamble", { timeout: 30_000 }, async () => {
    const plain: AgentAdapter = { ...fakeAgy, id: "fake", supportsResume: false };
    const env = makeEnv([{ lines: [step(1, "ACTIVE", "run_command", { CommandLine: "ls" })] }], plain);
    const outcome = await run(env);
    assert.equal(kinds(await events(env), "monitor_stop").length, 0);
    assert.equal(env.stops, 0);
    assert.equal(env.spawns[0]!.stdin?.includes("Use file tools only") ?? false, false);
    assert.equal(outcome.facts.implementerExitCode, 0);
  });
});

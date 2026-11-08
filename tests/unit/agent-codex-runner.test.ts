/**
 * Unit tests for the Codex RoleRunner and its wiring (AW2-04b).
 *
 * Codex is the credential-free fake CLI (tests/fixtures/fake-codex.mjs) run via
 * process.execPath; the implementer is the fake agent; git and checks are stubs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanup, migrate } from "../helpers/db";
import { agentRuns, projects } from "../../src/db/schema";
import { fakeAdapter } from "../../src/core/agents/adapters/fake";
import { buildCodexEnv, probeCodex } from "../../src/core/agents/adapters/codex";
import { createCodexRoleRunner, codexRunDirFor } from "../../src/core/agents/codex-runner";
import { CODEX_EFFORT_LEVELS, CODEX_MODELS } from "../../src/core/agents/codex-constants";
import { defaultRoleRunners } from "../../src/core/agents/role-runners";
import { spawnAgentProcess, stopAgentProcess } from "../../src/core/agents/process";
import { getProviderProbes } from "../../src/core/agents/provider-probes";
import { runRequestSchema } from "../../src/core/agents/schema";
import { EFFORT_LEVELS } from "../../src/core/agents/types";
import {
  runAgentRun,
  type CheckResult,
  type OrchestratorDeps,
  type RunOutcome,
  type RunPolicy,
} from "../../src/core/agents/orchestrator";
import type { DiffSummaryResult } from "../../src/core/agents/workspace";
import { describeReviewIndependence } from "../../src/components/agents/runs/role-independence";
import {
  defaultReviewRoles,
  effortLevelsFor,
  implementerProviders,
} from "../../src/components/agents/runs/role-defaults";

const FIXTURE = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));
const EXE = { file: process.execPath, prefixArgs: [FIXTURE] };

let db: typeof import("../../src/db/client").db;
const tempDirs: string[] = [];
let counter = 0;

before(async () => {
  await migrate();
  ({ db } = await import("../../src/db/client"));
  db.insert(projects).values({ id: "prj-codex", name: "Codex" }).run();
});
after(async () => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  await cleanup();
});

const POLICY: RunPolicy = {
  checks: [{ name: "lint", argv: ["npm", "run", "lint"] }],
  excludedPaths: [],
};
const T = { timeout: 60_000 };
const ok = (name: string): CheckResult => ({ name, exitCode: 0, timedOut: false, durationMs: 1, output: "ok" });
const DIFF: DiffSummaryResult = {
  files: [{ path: "fake-output.txt", status: "added", additions: 1, deletions: 0, binary: false, outOfScope: false, excluded: false }],
  totals: { files: 1, additions: 1, deletions: 0 },
};

interface Env {
  runId: string;
  root: string;
  runStore: string;
  deps: OrchestratorDeps;
  controller: AbortController;
  spawns: number;
}

/** A run with planner + reviewer = codex (the fake CLI replaying `sequence`). */
function makeEnv(
  sequence: string,
  roles: Record<string, { provider: string }> = { planner: { provider: "codex" }, reviewer: { provider: "codex" } },
): Env {
  const runId = `run-codex-${++counter}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex runner "));
  tempDirs.push(root);
  const runStore = path.join(root, "run store");
  const worktreeRoot = path.join(root, "work trees");
  fs.mkdirSync(path.join(runStore, "runs"), { recursive: true });
  fs.mkdirSync(worktreeRoot, { recursive: true });
  const request = {
    projectId: "prj-codex",
    task: "do the thing",
    roles: { implementer: { provider: "fake", model: "success" }, ...roles },
    checks: ["lint"],
  };
  db.insert(agentRuns).values({ id: runId, projectId: "prj-codex", request: JSON.stringify(request) }).run();
  const controller = new AbortController();
  const wt = (r: string) => path.join(worktreeRoot, r);
  const env: Env = { runId, root, runStore, controller, spawns: 0, deps: undefined as unknown as OrchestratorDeps };
  env.deps = {
    db,
    implementer: fakeAdapter,
    review: async () => ({ verdict: "approve", findings: [] }),
    roleRunners: {
      codex: createCodexRoleRunner({
        executable: EXE,
        env: {
          ...process.env,
          FAKE_CODEX_SCENARIO_SEQUENCE: sequence,
          FAKE_CODEX_STATE_FILE: path.join(root, "codex-state"),
        },
        graceMs: 300,
      }),
    },
    workspace: {
      create: async ({ runId: r }) => {
        fs.mkdirSync(wt(r), { recursive: true });
        return { path: wt(r), branch: `agent/${r}`, baseSha: "a".repeat(40) };
      },
      commit: async () => "b".repeat(40),
      diff: async () => DIFF,
      patch: async () => ({ files: [], truncated: false }),
      pathFor: (_root, r) => wt(r),
      shortId: (r) => r.slice(-6),
    },
    spawn: (o) => {
      env.spawns++;
      return spawnAgentProcess(o);
    },
    stop: (h, o) => stopAgentProcess(h, o),
    runCheck: async (check) => ok(check.name),
    storage: { worktreeRoot, runStore },
    signal: controller.signal,
    stopGraceMs: 200,
  };
  return env;
}

const run = (env: Env): Promise<RunOutcome> =>
  runAgentRun(env.deps, { runId: env.runId, repoPath: path.join(env.root, "repo"), policy: POLICY });
/** Wraps the codex runner to record each call's runDir and whether its files existed (the run store is cleaned at the end). */
function spyOnCodex(env: Env): string[] {
  const real = env.deps.roleRunners!.codex!;
  const seen: string[] = [];
  const note = (i: { grantDir: string; role: "planner" | "reviewer"; round: number }) => {
    const dir = codexRunDirFor(i.grantDir, i.role, i.round);
    assert.ok(dir.startsWith(path.join(env.runStore, "runs", env.runId, "codex")), "runDir is in the run storage");
    const file = path.join(dir, `${i.role}-last-message.json`);
    seen.push(`${i.role}-r${i.round}:${fs.existsSync(file)}`);
  };
  env.deps = {
    ...env.deps,
    roleRunners: {
      codex: {
        runPlanner: async (i, s) => {
          const r = await real.runPlanner(i, s);
          note(i);
          return r;
        },
        runReviewer: async (i, s) => {
          const r = await real.runReviewer(i, s);
          note(i);
          return r;
        },
      },
    },
  };
  return seen;
}

describe("Codex as planner and reviewer in a full run", () => {
  it("plan-valid + review-approve: succeeded, runDirs per role and round", T, async () => {
    const env = makeEnv("plan-scoped,review-approve");
    const seen = spyOnCodex(env);
    const out = await run(env);
    assert.equal(out.status, "succeeded", JSON.stringify(out));
    assert.equal(env.spawns, 1);
    assert.deepEqual(seen, ["planner-r0:true", "reviewer-r0:true"]);
  });

  it("review-request-changes starts a correction round; runDirs stay distinct", T, async () => {
    const env = makeEnv("plan-scoped,review-request-changes,review-approve");
    const seen = spyOnCodex(env);
    const out = await run(env);
    assert.equal(out.status, "succeeded", JSON.stringify(out));
    assert.deepEqual(out.rounds, { corrections: 1 });
    assert.equal(env.spawns, 2);
    assert.deepEqual(seen, ["planner-r0:true", "reviewer-r0:true", "reviewer-r1:true"]);
  });

  it("review-malformed fails with no valid review", T, async () => {
    const env = makeEnv("plan-scoped,review-malformed");
    const out = await run(env);
    assert.equal(out.status, "failed");
    assert.match(out.missing[0] ?? "", /^no valid review: codex invalid-json/);
  });

  it("plan-malformed fails before the implementer starts", T, async () => {
    const env = makeEnv("plan-malformed");
    const out = await run(env);
    assert.equal(out.status, "failed");
    assert.match(out.missing[0] ?? "", /^no valid plan: codex invalid-json/);
    assert.equal(env.spawns, 0);
  });

  it("aborting during a hanging Codex review ends stopped", T, async () => {
    const env = makeEnv("plan-scoped,hang");
    const real = env.deps.roleRunners!.codex!;
    env.deps = {
      ...env.deps,
      roleRunners: {
        codex: {
          runPlanner: (i, s) => real.runPlanner(i, s),
          runReviewer: (i, s) => {
            setTimeout(() => env.controller.abort(), 600);
            return real.runReviewer(i, s);
          },
        },
      },
    };
    const out = await run(env);
    assert.equal(out.status, "stopped", JSON.stringify(out));
  });

  it("a codex role with no codex runner still fails up front", T, async () => {
    const env = makeEnv("plan-valid");
    env.deps = { ...env.deps, roleRunners: {} };
    const out = await run(env);
    assert.equal(out.status, "failed");
    assert.match(out.error ?? "", /no runner is available for provider "codex"/);
  });
});

describe("Codex role runner", () => {
  const input = (dir: string, role: "planner" | "reviewer", round: number, wt: string) => ({
    role,
    prompt: "p",
    workspacePath: wt,
    grantDir: dir,
    round,
    model: "gpt-6.1-sol",
    effort: "medium",
  });

  it("maps failures to kind plus message; an unknown effort never spawns", T, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex runner unit "));
    tempDirs.push(root);
    const runner = createCodexRoleRunner({
      executable: EXE,
      env: { ...process.env, FAKE_CODEX_SCENARIO: "bad-effort" },
    });
    const bad = await runner.runReviewer(
      { ...input(root, "reviewer", 0, root), effort: "banana" },
      new AbortController().signal,
    );
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.failure, /^codex invalid-request: .*Invalid Codex reasoning effort/);
    const r = await runner.runPlanner(input(root, "planner", 0, root), new AbortController().signal);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.failure, /^codex codex-error: /);
  });

  it("reports a missing executable with the paths tried", T, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex runner none "));
    tempDirs.push(root);
    const runner = createCodexRoleRunner({ resolve: () => ({ ok: false, tried: ["/nowhere/codex"] }) });
    const r = await runner.runPlanner(input(root, "planner", 0, root), new AbortController().signal);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.failure, /codex not installed \(tried \/nowhere\/codex\)/);
  });

  it("runDir is per role and round", () => {
    const dirs = [
      codexRunDirFor("g", "planner", 0),
      codexRunDirFor("g", "reviewer", 0),
      codexRunDirFor("g", "reviewer", 1),
    ];
    assert.equal(new Set(dirs).size, 3);
  });

  it("default runners register codex next to claude-code", () => {
    const map = defaultRoleRunners();
    assert.ok(map.codex && map["claude-code"]);
  });
});

describe("Codex is not an implementer", () => {
  const base = { projectId: "p", task: "t", checks: [] };
  it("a request with implementer codex is rejected with a clear message", () => {
    const res = runRequestSchema.safeParse({ ...base, roles: { implementer: { provider: "codex" } } });
    assert.equal(res.success, false);
    if (!res.success) assert.match(res.error.issues[0]?.message ?? "", /Codex cannot be the implementer/);
  });
  it("codex as planner and reviewer is accepted", () => {
    const res = runRequestSchema.safeParse({
      ...base,
      roles: {
        implementer: { provider: "claude-code" },
        planner: { provider: "codex", model: "gpt-6.1-sol", effort: "medium" },
        reviewer: { provider: "codex" },
      },
    });
    assert.equal(res.success, true);
  });
  it("the implementer select never lists codex", () => {
    const list = implementerProviders([{ id: "claude-code" }, { id: "codex" }, { id: "fake", canImplement: false }]);
    assert.deepEqual(list.map((p) => p.id), ["claude-code"]);
  });
});

describe("Codex probe surfaced", () => {
  it("getProviderProbes lists codex with its models and sign-in state", async () => {
    const providers = await getProviderProbes({
      claudeProbe: async () => ({ installed: true, authenticated: true }),
      fakeProbe: async () => ({ installed: true, authenticated: true }),
      codexProbe: async () => ({ installed: true, version: "0.160.0", authenticated: true }),
    });
    const codex = providers.find((p) => p.id === "codex");
    assert.ok(codex);
    assert.equal(codex.installed, true);
    assert.equal(codex.authenticated, true);
    assert.ok(codex.models.includes("gpt-6.1-sol") && codex.models.includes("gpt-6-luna"));
    assert.deepEqual(codex.models, CODEX_MODELS);
  });

  it("a throwing codex probe is reported as not installed", async () => {
    const providers = await getProviderProbes({
      claudeProbe: async () => ({ installed: true, authenticated: true }),
      fakeProbe: async () => ({ installed: true, authenticated: true }),
      codexProbe: async () => {
        throw new Error("boom");
      },
    });
    const codex = providers.find((p) => p.id === "codex");
    assert.equal(codex?.installed, false);
    assert.equal(codex?.error, "boom");
  });

  it("probeCodex through the fixture reports signed in, and signed out", async () => {
    const resolveExecutable = () => ({ ok: true as const, file: process.execPath, prefixArgs: [FIXTURE], source: "test" });
    const inRes = await probeCodex({ resolveExecutable });
    assert.equal(inRes.installed, true);
    assert.equal(inRes.authenticated, true);
    process.env.FAKE_CODEX_LOGGED_OUT = "1";
    try {
      const outRes = await probeCodex({ resolveExecutable });
      assert.equal(outRes.authenticated, false);
    } finally {
      delete process.env.FAKE_CODEX_LOGGED_OUT;
    }
  });
});

describe("run form role defaults", () => {
  const signedIn = { id: "codex", installed: true, authenticated: true as const };
  it("codex installed and signed in: planner and reviewer default to gpt-6.1-sol medium", () => {
    const d = defaultReviewRoles([{ id: "claude-code", installed: true, authenticated: true }, signedIn]);
    const expected = { provider: "codex", model: "gpt-6.1-sol", effort: "medium" };
    assert.deepEqual(d.planner, expected);
    assert.deepEqual(d.reviewer, expected);
  });
  it("not signed in, unknown, not installed or absent: defaults unchanged (none)", () => {
    const none = { provider: "", model: "", effort: "" };
    for (const providers of [
      [{ id: "codex", installed: true, authenticated: false as const }],
      [{ id: "codex", installed: true, authenticated: "unknown" as const }],
      [{ id: "codex", installed: false, authenticated: true as const }],
      [{ id: "claude-code", installed: true, authenticated: true as const }],
      [],
    ]) {
      const d = defaultReviewRoles(providers);
      assert.deepEqual(d.planner, none);
      assert.deepEqual(d.reviewer, none);
    }
  });
  it("effort pickers: codex roles get the Codex list, others the standard list", () => {
    assert.deepEqual(effortLevelsFor("codex"), [...CODEX_EFFORT_LEVELS]);
    assert.deepEqual(effortLevelsFor("claude-code"), [...EFFORT_LEVELS]);
  });
  it("implementer claude-code + reviewer codex is labelled Different provider", () => {
    assert.deepEqual(
      describeReviewIndependence({ implementer: { provider: "claude-code" }, reviewer: { provider: "codex" } }),
      { kind: "separate-provider", label: "Different provider" },
    );
  });
});

describe("Codex environment allowlist (review B1)", () => {
  it("buildCodexEnv drops secrets and keeps PATH and CODEX_HOME", () => {
    const env = buildCodexEnv({
      PATH: "/bin",
      CODEX_HOME: "/h/.codex",
      DESKTOP_INTERNAL_SECRET: "s",
      ANTHROPIC_API_KEY: "k",
      OPENAI_API_KEY: "o",
      FOO_TOKEN: "t",
    });
    assert.deepEqual(env, { PATH: "/bin", CODEX_HOME: "/h/.codex" });
  });

  it("the production runner (no env dep) spawns Codex with a filtered env", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-env-"));
    tempDirs.push(dir);
    const dump = path.join(dir, "env.json");
    const script = path.join(dir, "dump-env.mjs");
    fs.writeFileSync(script, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env)); process.exit(1);`);
    const saved = { s: process.env.DESKTOP_INTERNAL_SECRET, f: process.env.FOO_TOKEN };
    process.env.DESKTOP_INTERNAL_SECRET = "secret";
    process.env.FOO_TOKEN = "tok";
    try {
      const runner = createCodexRoleRunner({ executable: { file: process.execPath, prefixArgs: [script] } });
      await runner.runPlanner(
        { role: "planner", prompt: "p", workspacePath: dir, grantDir: dir, round: 0 },
        new AbortController().signal,
      );
    } finally {
      if (saved.s === undefined) delete process.env.DESKTOP_INTERNAL_SECRET; else process.env.DESKTOP_INTERNAL_SECRET = saved.s;
      if (saved.f === undefined) delete process.env.FOO_TOKEN; else process.env.FOO_TOKEN = saved.f;
    }
    const seen = JSON.parse(fs.readFileSync(dump, "utf8")) as Record<string, string>;
    assert.equal(seen.DESKTOP_INTERNAL_SECRET, undefined);
    assert.equal(seen.FOO_TOKEN, undefined);
    assert.ok(Object.keys(seen).some((k) => k.toLowerCase() === "path"));
  });
});

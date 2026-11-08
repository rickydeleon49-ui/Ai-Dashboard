import assert from "node:assert/strict";
import fs from "node:fs";
import test, { beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ANTIGRAVITY_DENIED_FLAGS,
  ANTIGRAVITY_DENIED_SUBCOMMANDS,
  ANTIGRAVITY_EFFORT_LEVELS,
  AntigravityRunAccumulator,
  antigravityAdapter,
  assertAntigravityArgvAllowed,
  buildAntigravityEnv,
  buildAntigravityInvocation,
  checkAntigravitySignIn,
  clearAntigravitySignInCache,
  getAntigravitySignInCache,
  listAntigravityModels,
  parseAntigravityLine,
  parseAntigravityModels,
  probeAntigravity,
  stripAnsi,
  type CommandRunner,
} from "../../src/core/agents/adapters/antigravity";
import type { InvocationRequest, NormalizedEvent } from "../../src/core/agents/adapters/types";

const ESC = String.fromCharCode(27);
const CONV_ID = "909c2747-5771-4fbc-a439-f0423b23e63a";

function replay(name: string) {
  const file = fileURLToPath(new URL(`../fixtures/agy/${name}.jsonl`, import.meta.url));
  const raw = fs.readFileSync(file);
  assert.notEqual(raw[0], 0xef, "fixture has a BOM");
  const text = raw.toString("utf8");
  assert.ok(!text.includes("\r"), "fixture has CR");
  assert.ok(!/ricky/i.test(text), "fixture leaks the user name");
  const acc = new AntigravityRunAccumulator();
  const events: NormalizedEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    events.push(...acc.ingest(JSON.parse(line)));
  }
  events.push(...acc.finish());
  return { acc, events };
}

const baseReq: InvocationRequest = {
  workspacePath: "H:\\work\\tree",
  prompt: "Fix the thing",
  checkCommands: [],
  excludedPaths: [],
  grantDir: "H:\\grants",
};

const build = (req: Partial<InvocationRequest> = {}, printTimeoutSeconds?: number) =>
  buildAntigravityInvocation(
    { ...baseReq, ...req },
    { executableFile: "agy-test-bin", baseEnv: {}, printTimeoutSeconds },
  );

// ---- fixture replay ----

test("t1: SUCCESS with an outside-workspace read is just a tool event here", () => {
  const { acc, events } = replay("t1");
  assert.equal(acc.outcome, "succeeded");
  assert.deepEqual(acc.failures, []);
  assert.equal(acc.conversationId, "b7c2ebcb-7376-4e3f-acbc-12a7551f5376");
  const calls = events.filter((e) => e.kind === "tool_call");
  assert.equal(calls.length, 1);
  const p = calls[0]!.payload as { name: string; path: string; state: string };
  assert.equal(p.name, "read_file");
  assert.match(p.path, /SKILL\.md$/);
  assert.equal(p.state, "ACTIVE");
  assert.ok(events.some((e) => e.kind === "tool_result"));
  const texts = events.filter((e) => e.kind === "output").map((e) => (e.payload as any).text);
  assert.ok(texts.includes("OK"));
});

test("t2: ERROR step makes a SUCCESS result failed and denied_actions are recorded", () => {
  const { acc, events } = replay("t2");
  assert.equal(acc.resultStatus, "SUCCESS");
  assert.equal(acc.outcome, "failed");
  assert.deepEqual(
    acc.failures.map((f) => f.kind),
    ["tool_error"],
  );
  assert.equal(acc.failures[0]!.toolName, "run_command");
  assert.deepEqual(acc.deniedActions, [{ action: "command", displayName: "RunCommand" }]);
  const warning = events.find((e) => e.kind === "warning");
  assert.deepEqual(warning?.payload, { deniedAction: "command", displayName: "RunCommand" });
  const errResult = events.find(
    (e) => e.kind === "tool_result" && (e.payload as any).isError === true,
  );
  assert.equal((errResult!.payload as any).command, "git status");
  const final = events.find((e) => e.kind === "output" && (e.payload as any).final);
  assert.equal((final!.payload as any).isError, true);
  assert.ok(events.some((e) => e.kind === "error"));
});

test("t3 and t4 succeed", () => {
  for (const name of ["t3", "t4"]) {
    const { acc, events } = replay(name);
    assert.equal(acc.outcome, "succeeded", name);
    assert.deepEqual(acc.failures, [], name);
    assert.deepEqual(acc.deniedActions, [], name);
    assert.ok(!events.some((e) => e.kind === "error"), name);
  }
  assert.equal(replay("t3").acc.conversationId, CONV_ID);
});

test("t5: continuation keeps the t3 conversation id and succeeds", () => {
  const { acc, events } = replay("t5");
  assert.equal(acc.conversationId, CONV_ID);
  assert.equal(acc.outcome, "succeeded");
  const init = events[0]!;
  assert.equal(init.kind, "output");
  assert.equal((init.payload as any).sessionId, CONV_ID);
  assert.equal((init.payload as any).model, "gemini-3.8-flash-medium");
});

test("non-SUCCESS result status is failed; missing result is failed on finish()", () => {
  const acc = new AntigravityRunAccumulator();
  acc.ingest({ event: "result", result: { conversation_id: CONV_ID, status: "FAILED", response: "" } });
  assert.equal(acc.outcome, "failed");
  assert.equal(acc.failures[0]!.kind, "cli_status");

  const none = new AntigravityRunAccumulator();
  assert.equal(none.outcome, "running");
  const evs = none.finish();
  assert.equal(none.outcome, "failed");
  assert.equal(none.failures[0]!.kind, "no_result");
  assert.equal(evs[0]!.kind, "error");
  assert.deepEqual(none.finish(), []);
});

test("accumulators are independent (no module state)", () => {
  const a = new AntigravityRunAccumulator();
  const b = new AntigravityRunAccumulator();
  a.ingest({
    event: "step_update",
    step_update: { conversation_id: "x", step_index: 1, state: "ERROR", step_type: "tool", tool_name: "run_command" },
  });
  a.ingest({ event: "result", result: { status: "SUCCESS" } });
  b.ingest({ event: "result", result: { status: "SUCCESS" } });
  assert.equal(a.outcome, "failed");
  assert.equal(b.outcome, "succeeded");
});

test("parseLine ignores junk and the adapter exposes the id", () => {
  assert.deepEqual(parseAntigravityLine(null), []);
  assert.deepEqual(parseAntigravityLine("x"), []);
  assert.deepEqual(parseAntigravityLine({ event: "mystery" }), []);
  assert.deepEqual(
    parseAntigravityLine({ event: "step_update", step_update: { step_type: "user_input", state: "DONE" } }),
    [],
  );
  assert.equal(antigravityAdapter.id, "antigravity");
  assert.equal(antigravityAdapter.displayName, "Antigravity");
  assert.equal(antigravityAdapter.supportsResume, true);
  assert.equal(antigravityAdapter.parseLine({ event: "init", conversation_id: "c", init: { model: "m" } }).length, 1);
});

// ---- argv ----

test("argv: required flags in order, prompt only on stdin", () => {
  const inv = build({ model: "gemini-3.8-flash-high", effort: "high" }, 300);
  assert.equal(inv.file, "agy-test-bin");
  assert.deepEqual(inv.args, [
    "-p=",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--model",
    "gemini-3.8-flash-high",
    "--effort",
    "high",
    "--mode",
    "accept-edits",
    "--sandbox",
    "--disable-slash-commands",
    "--print-timeout",
    "300s",
  ]);
  assert.equal(inv.cwd, baseReq.workspacePath);
  assert.ok(!inv.args.join(" ").includes("Fix the thing"));
  assert.equal(inv.stdin, `${JSON.stringify({ event: "user", message: { content: "Fix the thing" } })}\n`);
  assert.ok(inv.stdin.endsWith("}}\n"));
});

test("argv: model and effort are optional; resume adds --conversation", () => {
  const plain = build();
  assert.ok(!plain.args.includes("--model"));
  assert.ok(!plain.args.includes("--effort"));
  assert.ok(!plain.args.includes("--conversation"));
  const resumed = build({ resumeSessionId: CONV_ID });
  const i = resumed.args.indexOf("--conversation");
  assert.equal(resumed.args[i + 1], CONV_ID);
  assert.throws(() => build({ resumeSessionId: "--continue" }), /Invalid conversation id/);
});

test("argv: effort is validated against low..max", () => {
  for (const level of ANTIGRAVITY_EFFORT_LEVELS) {
    assert.doesNotThrow(() => build({ effort: level }));
  }
  assert.deepEqual([...ANTIGRAVITY_EFFORT_LEVELS], ["low", "medium", "high", "xhigh", "max"]);
  for (const bad of ["none", "minimal", "extreme", "", "HIGH"]) {
    assert.throws(() => build({ effort: bad }), /Invalid Antigravity effort/);
  }
  assert.throws(() => build({ model: "bad model; rm" }), /Invalid model name/);
  assert.throws(() => build({}, 0), /Invalid print timeout/);
});

test("argv: a big prompt stays out of argv", () => {
  const big = "x".repeat(200000);
  const inv = build({ prompt: big });
  assert.ok(inv.args.every((a) => a.length < 100));
  assert.ok(inv.stdin.length > 200000);
});

test("denylist: every denied flag is refused, bare and with =value", () => {
  assert.ok(ANTIGRAVITY_DENIED_FLAGS.includes("--dangerously-skip-permissions"));
  assert.ok(ANTIGRAVITY_DENIED_FLAGS.includes("--add-dir"));
  assert.ok(ANTIGRAVITY_DENIED_FLAGS.includes("--yolo"));
  for (const flag of ANTIGRAVITY_DENIED_FLAGS) {
    assert.throws(() => assertAntigravityArgvAllowed(["-p", flag]), /Denied Antigravity flag/, flag);
    assert.throws(() => assertAntigravityArgvAllowed([`${flag}=x`]), /Denied Antigravity flag/, flag);
  }
  for (const sub of ANTIGRAVITY_DENIED_SUBCOMMANDS) {
    assert.throws(() => assertAntigravityArgvAllowed([sub]), /Denied Antigravity subcommand/, sub);
  }
});

test("denylist: --mode must be accept-edits", () => {
  assert.doesNotThrow(() => assertAntigravityArgvAllowed(["--mode", "accept-edits"]));
  assert.doesNotThrow(() => assertAntigravityArgvAllowed(["--mode=accept-edits"]));
  for (const mode of ["plan", "auto", "bypass", ""]) {
    assert.throws(() => assertAntigravityArgvAllowed(["--mode", mode]), /Denied Antigravity mode/);
    assert.throws(() => assertAntigravityArgvAllowed([`--mode=${mode}`]), /Denied Antigravity mode/);
  }
  assert.throws(() => assertAntigravityArgvAllowed(["--mode"]), /Denied Antigravity mode/);
});

test("denylist guards buildInvocation through prefix args", () => {
  assert.throws(
    () =>
      buildAntigravityInvocation(baseReq, {
        executableFile: "agy-test-bin",
        prefixArgs: ["--dangerously-skip-permissions"],
      }),
    /Denied Antigravity flag/,
  );
});

// ---- env ----

test("env allowlist passes system vars and drops API keys", () => {
  const env = buildAntigravityEnv({
    PATH: "/bin",
    Path: "C:\\bin",
    USERPROFILE: "C:\\Users\\user",
    HTTPS_PROXY: "http://p",
    GEMINI_API_KEY: "secret",
    GOOGLE_API_KEY: "secret",
    ANTHROPIC_API_KEY: "secret",
    OPENAI_API_KEY: "secret",
    AWS_SECRET_ACCESS_KEY: "secret",
    CLAUDE_CODE_SESSION_ID: "s",
    EMPTY: undefined,
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.Path, "C:\\bin");
  assert.equal(env.USERPROFILE, "C:\\Users\\user");
  assert.equal(env.HTTPS_PROXY, "http://p");
  assert.deepEqual(Object.keys(env).sort(), ["HTTPS_PROXY", "PATH", "Path", "USERPROFILE"]);
  assert.deepEqual(build().env, {});
});

// ---- ANSI and models ----

test("stripAnsi removes CSI and OSC sequences", () => {
  assert.equal(stripAnsi(`${ESC}[Khello${ESC}[0m`), "hello");
  assert.equal(stripAnsi(`${ESC}[1;32mgreen${ESC}[0m text`), "green text");
  assert.equal(stripAnsi(`${ESC}]0;title\u0007body`), "body");
  assert.equal(stripAnsi("plain"), "plain");
});

test("parseAntigravityModels handles ANSI, the header line and CRLF", () => {
  const out = [
    `${ESC}[KFetching available models...`,
    "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
    `${ESC}[K`,
    "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
    "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
    "gemini-3.8-flash-high\tduplicate",
    "",
  ].join("\r\n");
  assert.deepEqual(parseAntigravityModels(out), [
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
    { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
  ]);
  assert.deepEqual(parseAntigravityModels(""), []);
});

// ---- probe, models, sign-in ----

const okResolve = () => ({ ok: true as const, file: "agy-test-bin", prefixArgs: [] as string[] });

function recordingRunner(handler: (args: string[]) => string) {
  const calls: string[][] = [];
  const runner: CommandRunner = async (_file, args) => {
    calls.push(args);
    return { stdout: handler(args), stderr: "", exitCode: 0 };
  };
  return { calls, runner };
}

beforeEach(() => clearAntigravitySignInCache());

test("probe: version only, authentication unknown, no sign-in turn", async () => {
  const { calls, runner } = recordingRunner(() => "1.5.3\n");
  const res = await probeAntigravity({ resolveExecutable: okResolve as any, runner });
  assert.deepEqual(calls, [["--version"]]);
  assert.equal(res.installed, true);
  assert.equal(res.version, "1.5.3");
  assert.equal(res.authenticated, "unknown");
  assert.equal(res.executable, "agy-test-bin");
  assert.equal(getAntigravitySignInCache(), undefined);
});

test("probe: not installed", async () => {
  const res = await probeAntigravity({
    resolveExecutable: (() => ({ ok: false, tried: ["a", "b"] })) as any,
  });
  assert.equal(res.installed, false);
  assert.deepEqual(res.tried, ["a", "b"]);
});

test("listAntigravityModels runs `agy models` and strips ANSI", async () => {
  const { calls, runner } = recordingRunner(
    () => `${ESC}[KFetching available models...\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n`,
  );
  const models = await listAntigravityModels({ resolveExecutable: okResolve as any, runner });
  assert.deepEqual(calls, [["models"]]);
  assert.deepEqual(models, [{ id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" }]);
});

test("sign-in: runs only when called, caches with a timestamp, honours age and force", async () => {
  let clock = 1_000;
  const now = () => clock;
  const success = JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "OK" } });
  const { calls, runner } = recordingRunner(() => `${success}\n`);
  const deps = { resolveExecutable: okResolve as any, runner, now, maxAgeMs: 5_000 };

  assert.equal(getAntigravitySignInCache(), undefined);
  const first = await checkAntigravitySignIn(deps);
  assert.deepEqual(first, { authenticated: true, checkedAt: 1_000 });
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.includes("-p"));
  assert.ok(calls[0]!.includes("accept-edits"));
  assert.deepEqual(getAntigravitySignInCache(), { authenticated: true, checkedAt: 1_000 });

  clock = 3_000;
  await checkAntigravitySignIn(deps);
  assert.equal(calls.length, 1, "cache hit inside the max age");

  clock = 6_001;
  const refreshed = await checkAntigravitySignIn(deps);
  assert.equal(calls.length, 2, "expired cache re-runs");
  assert.equal(refreshed.checkedAt, 6_001);

  await checkAntigravitySignIn({ ...deps, force: true });
  assert.equal(calls.length, 3);

  // probe now reports the cached answer without running anything
  const probeRun = recordingRunner(() => "1.5.3");
  const probed = await probeAntigravity({ resolveExecutable: okResolve as any, runner: probeRun.runner });
  assert.equal(probed.authenticated, true);
  assert.equal(probeRun.calls.length, 1);
});

test("sign-in: non-SUCCESS is false, no result is unknown", async () => {
  const failed = recordingRunner(() => `${JSON.stringify({ event: "result", result: { status: "ERROR" } })}\n`);
  const res = await checkAntigravitySignIn({
    resolveExecutable: okResolve as any,
    runner: failed.runner,
    now: () => 1,
  });
  assert.equal(res.authenticated, false);

  const silent = recordingRunner(() => "not json\n");
  const unknown = await checkAntigravitySignIn({
    resolveExecutable: okResolve as any,
    runner: silent.runner,
    now: () => 2,
    force: true,
  });
  assert.equal(unknown.authenticated, "unknown");
  assert.ok(unknown.error);
});

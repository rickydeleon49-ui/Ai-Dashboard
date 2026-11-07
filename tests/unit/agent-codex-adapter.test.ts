import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertCodexArgvAllowed,
  buildCodexArgv,
  CODEX_DENIED_FLAGS,
  codexAdapter,
  codexReviewerJsonSchema,
  decodeCodexErrorMessage,
  parseCodexJsonl,
  parseCodexResult,
  probeCodex,
  runCodex,
  type CodexEvent,
  type CodexRole,
  type RunCodexOptions,
} from "../../src/core/agents/adapters/codex";
import { resolveExecutable } from "../../src/core/agents/resolve-executable";
import { reviewerOutputSchema } from "../../src/core/agents/schema";

const FIXTURE = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));
const SHIM_FIXTURE = fileURLToPath(new URL("../fixtures/codex-shim.cmd", import.meta.url));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-adapter-test-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let counter = 0;
function dirs() {
  const base = path.join(root, `case-${++counter}`);
  const runDir = path.join(base, "run");
  const worktree = path.join(base, "worktree");
  fs.mkdirSync(worktree, { recursive: true });
  return { runDir, worktree };
}

function runFake(
  role: CodexRole,
  scenario: string,
  extra: Partial<RunCodexOptions> = {},
  env: Record<string, string> = {},
) {
  const { runDir, worktree } = dirs();
  return runCodex({
    role,
    prompt: "do the thing",
    runDir,
    worktree,
    model: "gpt-test",
    effort: "medium",
    file: process.execPath,
    prefixArgs: [FIXTURE],
    env: { ...process.env, FAKE_CODEX_SCENARIO: scenario, ...env },
    graceMs: 500,
    ...extra,
  });
}

test("argv has the exact shape for planner and reviewer", async () => {
  for (const role of ["planner", "reviewer"] as const) {
    const { runDir, worktree } = dirs();
    const argv = await buildCodexArgv(role, { runDir, worktree, model: "gpt-x", effort: "high" });
    assert.deepEqual(argv.args, [
      "exec",
      "-",
      "--json",
      "--output-schema",
      path.join(path.resolve(runDir), `${role}-output.schema.json`),
      "-o",
      path.join(path.resolve(runDir), `${role}-last-message.json`),
      "-m",
      "gpt-x",
      "-c",
      'model_reasoning_effort="high"',
      "-s",
      "read-only",
      "-C",
      worktree,
      "--ignore-user-config",
    ]);
    assert.ok(fs.existsSync(argv.schemaFile));
    assert.ok(!argv.args.includes("do the thing"));
  }
});

test("argv omits model and effort when unset", async () => {
  const { runDir, worktree } = dirs();
  const { args } = await buildCodexArgv("planner", { runDir, worktree });
  assert.ok(!args.includes("-m"));
  assert.ok(!args.includes("-c"));
});

test("denylist refuses every refused flag before spawn", () => {
  for (const flag of CODEX_DENIED_FLAGS) {
    assert.throws(() => assertCodexArgvAllowed(["exec", "-", flag]), /Denied Codex flag/);
    assert.throws(() => assertCodexArgvAllowed(["exec", `${flag}=1`]), /Denied Codex flag/);
  }
  assert.throws(() => assertCodexArgvAllowed(["exec", "-s", "danger-full-access"]));
  assert.throws(() => assertCodexArgvAllowed(["exec", "--sandbox", "danger-full-access"]));
  assert.throws(() => assertCodexArgvAllowed(["exec", "--sandbox=danger-full-access"]));
  assert.throws(() => assertCodexArgvAllowed(["exec", "-s=danger-full-access"]));
  assert.doesNotThrow(() => assertCodexArgvAllowed(["exec", "-s", "read-only"]));
});

test("denylist runs inside runCodex before spawning (prefix args)", async () => {
  const { runDir, worktree } = dirs();
  await assert.rejects(
    runCodex({
      role: "planner",
      prompt: "x",
      runDir,
      worktree,
      file: process.execPath,
      prefixArgs: [FIXTURE, "--ignore-rules"],
    }),
    /Denied Codex flag/,
  );
});

test("invalid effort is rejected before spawn", async () => {
  const { runDir, worktree } = dirs();
  for (const effort of ["banana", "ultra", "MEDIUM", ""]) {
    await assert.rejects(
      buildCodexArgv("planner", { runDir, worktree, effort }),
      /Invalid Codex reasoning effort/,
    );
  }
  await assert.rejects(
    runCodex({
      role: "planner",
      prompt: "x",
      runDir,
      worktree,
      effort: "banana",
      file: "does-not-exist-never-spawned",
    }),
    /Invalid Codex reasoning effort/,
  );
  for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    await buildCodexArgv("planner", { runDir, worktree, effort });
  }
});

test("probe: signed in, version recorded", async () => {
  const out = await probeCodex({
    resolveExecutable: () => ({ ok: true, file: process.execPath, prefixArgs: [FIXTURE], source: FIXTURE }),
    now: () => 1234,
  });
  assert.equal(out.installed, true);
  assert.equal(out.version, "0.160.0-fake");
  assert.equal(out.authenticated, true);
  assert.equal(out.checkedAt, 1234);
});

test("probe: signed out via exit code and output", async () => {
  const prev = process.env.FAKE_CODEX_LOGGED_OUT;
  process.env.FAKE_CODEX_LOGGED_OUT = "1";
  try {
    const out = await probeCodex({
      resolveExecutable: () => ({ ok: true, file: process.execPath, prefixArgs: [FIXTURE], source: FIXTURE }),
    });
    assert.equal(out.installed, true);
    assert.equal(out.authenticated, false);
  } finally {
    if (prev === undefined) delete process.env.FAKE_CODEX_LOGGED_OUT;
    else process.env.FAKE_CODEX_LOGGED_OUT = prev;
  }
});

test("probe: not installed reports tried paths", async () => {
  const out = await probeCodex({ resolveExecutable: () => ({ ok: false, tried: ["/a/codex"] }) });
  assert.equal(out.installed, false);
  assert.deepEqual(out.tried, ["/a/codex"]);
});

test("planner plan-valid validates; thread id and usage recorded", async () => {
  const events: CodexEvent[] = [];
  const out = await runFake("planner", "plan-valid", { onEvent: (e) => events.push(e) });
  assert.ok(out.result.ok, JSON.stringify(out.result));
  assert.equal(out.sessionId, "fake-thread-plan-valid");
  assert.deepEqual(out.usage, {
    inputTokens: 19000,
    cachedInputTokens: 13000,
    cacheWriteInputTokens: 0,
    outputTokens: 500,
    reasoningOutputTokens: 200,
  });
  assert.ok(events.some((e) => (e.payload as { text?: string }).text?.includes("fake codex")));
});

test("reviewer approve and request_changes validate", async () => {
  const a = await runFake("reviewer", "review-approve");
  assert.ok(a.result.ok);
  const r = await runFake("reviewer", "review-request-changes");
  assert.ok(r.result.ok);
  if (r.result.ok) {
    const v = r.result.value as { verdict: string; findings: { severity: string }[] };
    assert.equal(v.verdict, "request_changes");
    assert.equal(v.findings[0]?.severity, "P1");
  }
});

test("malformed and missing outputs are typed failures", async () => {
  const pm = await runFake("planner", "plan-malformed");
  assert.ok(!pm.result.ok && pm.result.kind === "invalid-json");
  const rm = await runFake("reviewer", "review-malformed");
  assert.ok(!rm.result.ok && rm.result.kind === "invalid-json");
  const missing = await runFake("reviewer", "review-missing");
  assert.ok(!missing.result.ok && missing.result.kind === "missing-output");
});

test("a plan fed to the reviewer role is a schema failure, not a result", async () => {
  const out = await runFake("reviewer", "plan-valid");
  assert.ok(!out.result.ok && out.result.kind === "schema-invalid");
});

test("bad-effort scenario surfaces the inner service message", async () => {
  const out = await runFake("planner", "bad-effort");
  assert.ok(!out.result.ok && out.result.kind === "codex-error");
  assert.match(out.errorMessage ?? "", /^Invalid value '(?:medium|banana)'\. Supported values are/);
  assert.ok(!out.errorMessage?.includes("{"));
});

test("decodeCodexErrorMessage: nested JSON, plain string, junk", () => {
  assert.equal(
    decodeCodexErrorMessage(JSON.stringify({ error: { message: "Invalid value 'banana'" } })),
    "Invalid value 'banana'",
  );
  assert.equal(decodeCodexErrorMessage(JSON.stringify({ message: "top" })), "top");
  assert.equal(decodeCodexErrorMessage("plain failure"), "plain failure");
  assert.equal(decodeCodexErrorMessage("{not json"), "{not json");
  assert.equal(decodeCodexErrorMessage(undefined), "Codex reported an error");
});

test("event mapping from JSONL", () => {
  const evs = parseCodexJsonl(
    [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text: "hi" } }),
      JSON.stringify({ type: "item.completed", item: { id: "j", type: "command_execution" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } }),
      JSON.stringify({ type: "turn.failed", error: { message: JSON.stringify({ error: { message: "boom" } }) } }),
    ].join("\n"),
    "planner",
  );
  assert.deepEqual(
    evs.map((e) => [e.kind, e.payload]),
    [
      ["output", { sessionId: "t1" }],
      ["output", { text: "hi" }],
      [
        "output",
        {
          final: true,
          usage: {
            inputTokens: 5,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 2,
            reasoningOutputTokens: 0,
          },
        },
      ],
      ["error", { message: "boom" }],
    ],
  );
});

test("reviewer JSON schema for Codex requires path and line as nullable; null normalises away", () => {
  const schema = codexReviewerJsonSchema() as {
    properties: { findings: { items: { required: string[]; properties: Record<string, unknown> } } };
  };
  const items = schema.properties.findings.items;
  assert.deepEqual([...items.required].sort(), ["actionable", "line", "message", "path", "severity"]);
  assert.deepEqual((items.properties.path as { anyOf: unknown[] }).anyOf.at(-1), { type: "null" });

  // The shared Claude-path schema is unchanged: path/line stay optional.
  assert.ok(
    reviewerOutputSchema.safeParse({
      verdict: "request_changes",
      findings: [{ severity: "P2", message: "m", actionable: true }],
    }).success,
  );

  const { runDir } = dirs();
  fs.mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, "out.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      verdict: "request_changes",
      findings: [{ severity: "P2", path: null, line: null, message: "m", actionable: true }],
    }),
  );
  const res = parseCodexResult("reviewer", file);
  assert.ok(res.ok, JSON.stringify(res));
  if (res.ok) assert.ok(!("path" in (res.value as { findings: object[] }).findings[0]!));
});

test("written reviewer schema file is the Codex variant", async () => {
  const { runDir, worktree } = dirs();
  const argv = await buildCodexArgv("reviewer", { runDir, worktree });
  const onDisk = JSON.parse(fs.readFileSync(argv.schemaFile, "utf8"));
  assert.deepEqual(onDisk, codexReviewerJsonSchema());
});

test("windows: codex.cmd shim fixture resolves to node.exe + real entry, never the .cmd", () => {
  const shim = fs.readFileSync(SHIM_FIXTURE, "utf8");
  const dir = "C:\\Users\\me\\AppData\\Roaming\\npm";
  const entry = `${dir}\\node_modules\\@openai\\codex\\bin\\codex.js`;
  const lower = new Map<string, string>([
    [`${dir}\\codex.cmd`.toLowerCase(), shim],
    [entry.toLowerCase(), ""],
    [`${dir}\\node.exe`.toLowerCase(), ""],
  ]);
  const r = resolveExecutable("codex", {
    platform: "win32",
    env: { PATH: "C:\\Tools", APPDATA: "C:\\Users\\me\\AppData\\Roaming", USERPROFILE: "C:\\Users\\me" },
    fileExists: (p) => lower.has(p.toLowerCase()),
    readFile: (p) => lower.get(p.toLowerCase()) ?? null,
  });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.file, `${dir}\\node.exe`);
    assert.deepEqual(r.prefixArgs, [entry]);
    assert.ok(!/\.(cmd|bat)$/i.test(r.file));
  }
});

test("hang scenario is killed on abort", async () => {
  const ac = new AbortController();
  const events: CodexEvent[] = [];
  const started = new Promise<void>((resolve) => {
    const iv = setInterval(() => {
      if (events.length > 0) {
        clearInterval(iv);
        resolve();
      }
    }, 20);
  });
  const run = runFake("planner", "hang", { signal: ac.signal, onEvent: (e) => events.push(e) });
  await started;
  ac.abort();
  const out = await run;
  assert.ok(!out.result.ok && out.result.kind === "aborted");
  assert.equal(out.exit.stoppedByUs, true);
  assert.equal(out.sessionId, "fake-thread-hang");
});

test("adapter object exposes the expected surface", () => {
  assert.equal(codexAdapter.id, "codex");
  assert.equal(typeof codexAdapter.probe, "function");
});

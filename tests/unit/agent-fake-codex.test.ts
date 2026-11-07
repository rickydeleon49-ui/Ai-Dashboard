/**
 * Unit tests for fake Codex CLI fixture (AW2-08a).
 *
 * Verifies that tests/fixtures/fake-codex.mjs implements the Codex CLI subset:
 *   - Probes: --version, login status (authenticated and unauthenticated).
 *   - Refused flags: denylist flags exit with code 3.
 *   - Unknown flags and commands exit with code 2.
 *   - Bad effort tier produces double-encoded JSON error and exits 1.
 *   - All scenarios emit valid NDJSON and expected output files.
 *   - Output files validate against plannerOutputSchema and reviewerOutputSchema.
 *   - Hang scenario remains running until killed.
 *   - Never writes to the -C directory.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import {
  plannerOutputSchema,
  reviewerOutputSchema,
} from "../../src/core/agents/schema";

const FIXTURE_PATH = fileURLToPath(
  new URL("../fixtures/fake-codex.mjs", import.meta.url),
);

const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "agent-fake-codex-test-"),
);

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function runFakeCodex(
  args: string[],
  options: { env?: Record<string, string>; input?: string } = {},
) {
  return spawnSync(process.execPath, [FIXTURE_PATH, ...args], {
    env: { ...process.env, ...options.env },
    input: options.input,
    encoding: "utf8",
  });
}

test("fake codex: --version returns fixture version and exits 0", () => {
  const res = runFakeCodex(["--version"]);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), "codex-cli 0.160.0-fake");
  assert.strictEqual(res.stderr, "");
});

test("fake codex: login status reports logged in when authenticated", () => {
  const res = runFakeCodex(["login", "status"], {
    env: { FAKE_CODEX_LOGGED_OUT: "0" },
  });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), "Logged in using ChatGPT");
  assert.strictEqual(res.stderr, "");
});

test("fake codex: login status reports not logged in and exits 1 when FAKE_CODEX_LOGGED_OUT=1", () => {
  const res = runFakeCodex(["login", "status"], {
    env: { FAKE_CODEX_LOGGED_OUT: "1" },
  });
  assert.strictEqual(res.status, 1);
  assert.strictEqual(res.stdout.trim(), "Not logged in");
  assert.strictEqual(res.stderr, "");
});

test("fake codex: refused flags exit 3 with refusal message", () => {
  const refusedFlags = [
    {
      args: ["exec", "-", "--dangerously-bypass-approvals-and-sandbox"],
      expected:
        "fake-codex: refused flag --dangerously-bypass-approvals-and-sandbox",
    },
    {
      args: ["exec", "-", "--dangerously-bypass-hook-trust"],
      expected: "fake-codex: refused flag --dangerously-bypass-hook-trust",
    },
    {
      args: ["exec", "-", "--approve-for-me"],
      expected: "fake-codex: refused flag --approve-for-me",
    },
    {
      args: ["exec", "-", "--ignore-rules"],
      expected: "fake-codex: refused flag --ignore-rules",
    },
    {
      args: ["exec", "-", "-s", "danger-full-access"],
      expected: "fake-codex: refused flag -s danger-full-access",
    },
    {
      args: ["exec", "-", "--sandbox", "danger-full-access"],
      expected: "fake-codex: refused flag -s danger-full-access",
    },
    {
      args: ["exec", "-", "-s=danger-full-access"],
      expected: "fake-codex: refused flag -s danger-full-access",
    },
    {
      args: ["--dangerously-bypass-approvals-and-sandbox"],
      expected:
        "fake-codex: refused flag --dangerously-bypass-approvals-and-sandbox",
    },
  ];

  for (const { args, expected } of refusedFlags) {
    const res = runFakeCodex(args);
    assert.strictEqual(
      res.status,
      3,
      `Expected exit code 3 for ${args.join(" ")}`,
    );
    assert.ok(
      res.stderr.includes(expected),
      `Expected stderr to include "${expected}", got "${res.stderr}"`,
    );
  }
});

test("fake codex: unknown flags or commands exit 2", () => {
  const unknownCases = [
    {
      args: ["exec", "-", "--unrecognized-option"],
      expected: "fake-codex: unknown flag --unrecognized-option",
    },
    {
      args: ["exec", "-", "unexpected-arg"],
      expected: "fake-codex: unexpected argument unexpected-arg",
    },
    {
      args: ["unknown-command"],
      expected: "fake-codex: unknown command unknown-command",
    },
    {
      args: ["--unknown-root-flag"],
      expected: "fake-codex: unknown flag --unknown-root-flag",
    },
    {
      args: [],
      expected: "fake-codex: missing command",
    },
  ];

  for (const { args, expected } of unknownCases) {
    const res = runFakeCodex(args);
    assert.strictEqual(
      res.status,
      2,
      `Expected exit code 2 for ${args.join(" ")}`,
    );
    assert.ok(
      res.stderr.includes(expected),
      `Expected stderr to include "${expected}", got "${res.stderr}"`,
    );
  }
});

test("fake codex: bad reasoning effort emits double-encoded error and exits 1", () => {
  // Case 1: scenario bad-effort with invalid effort
  const res1 = runFakeCodex(
    ["exec", "-", "--json", "-c", "model_reasoning_effort=banana"],
    {
      env: { FAKE_CODEX_SCENARIO: "bad-effort" },
      input: "Task prompt",
    },
  );

  assert.strictEqual(res1.status, 1);
  const lines1 = res1.stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  assert.strictEqual(lines1.length, 2);

  const event1 = JSON.parse(lines1[0]!);
  assert.strictEqual(event1.type, "error");
  assert.strictEqual(typeof event1.message, "string");
  // Double-decode message
  const serviceBody1 = JSON.parse(event1.message);
  assert.ok(
    serviceBody1.error?.message?.includes("Invalid value 'banana'"),
    "Message should mention banana",
  );
  assert.ok(
    serviceBody1.error?.message?.includes("Supported values are: 'none'"),
    "Message should list supported tiers",
  );

  const event2 = JSON.parse(lines1[1]!);
  assert.strictEqual(event2.type, "turn.failed");
  assert.strictEqual(typeof event2.error?.message, "string");
  // Double-decode error.message
  const serviceBody2 = JSON.parse(event2.error.message);
  assert.ok(
    serviceBody2.error?.message?.includes("Invalid value 'banana'"),
    "Turn failure should mention banana",
  );

  // Case 2: default scenario with invalid effort key
  const res2 = runFakeCodex(
    ["exec", "-", "--json", "-c", "model_reasoning_effort=unsupported_tier"],
    {
      env: { FAKE_CODEX_SCENARIO: "plan-valid" },
      input: "Task prompt",
    },
  );

  assert.strictEqual(res2.status, 1);
  const lines2 = res2.stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  assert.strictEqual(lines2.length, 2);
  const err2 = JSON.parse(lines2[0]!);
  const inner2 = JSON.parse(err2.message);
  assert.ok(inner2.error?.message?.includes("Invalid value 'unsupported_tier'"));
});

test("fake codex: defaults to plan-valid scenario when FAKE_CODEX_SCENARIO is unset", () => {
  const outPath = path.join(tempDir, "default-scenario-out.json");
  const env = { ...process.env };
  delete env.FAKE_CODEX_SCENARIO;

  const res = spawnSync(
    process.execPath,
    [FIXTURE_PATH, "exec", "-", "--json", "--output-last-message", outPath],
    {
      env,
      input: "Task prompt",
      encoding: "utf8",
    },
  );

  assert.strictEqual(res.status, 0);
  const lines = res.stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const threadEvent = JSON.parse(lines[0]!);
  assert.strictEqual(threadEvent.thread_id, "fake-thread-plan-valid");
  assert.ok(fs.existsSync(outPath));
  const parsed = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.strictEqual(plannerOutputSchema.safeParse(parsed).success, true);
});

test("fake codex: plan-valid scenario emits valid events and validates against plannerOutputSchema", () => {
  const schemaPath = path.join(tempDir, "plan.schema.json");
  fs.writeFileSync(schemaPath, "{}", "utf8");
  const outPath = path.join(tempDir, "plan-valid-out.json");
  const worktreeDir = path.join(tempDir, "worktree-plan");
  fs.mkdirSync(worktreeDir, { recursive: true });

  const res = runFakeCodex(
    [
      "exec",
      "-",
      "--json",
      "--output-schema",
      schemaPath,
      "-o",
      outPath,
      "-m",
      "GPT-6.1 Sol",
      "-c",
      "model_reasoning_effort=medium",
      "-s",
      "read-only",
      "-C",
      worktreeDir,
      "--ignore-user-config",
    ],
    {
      env: { FAKE_CODEX_SCENARIO: "plan-valid" },
      input: "Create a plan for the project",
    },
  );

  assert.strictEqual(res.status, 0);
  const lines = res.stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  assert.strictEqual(lines.length, 4);

  // Event 0: thread.started
  const threadEvent = JSON.parse(lines[0]!);
  assert.strictEqual(threadEvent.type, "thread.started");
  assert.strictEqual(threadEvent.thread_id, "fake-thread-plan-valid");

  // Event 1: turn.started
  const turnStartedEvent = JSON.parse(lines[1]!);
  assert.strictEqual(turnStartedEvent.type, "turn.started");

  // Event 2: item.completed
  const itemEvent = JSON.parse(lines[2]!);
  assert.strictEqual(itemEvent.type, "item.completed");
  assert.strictEqual(itemEvent.item?.type, "agent_message");
  assert.strictEqual(typeof itemEvent.item?.text, "string");

  // Event 3: turn.completed with 5 usage fields
  const turnCompletedEvent = JSON.parse(lines[3]!);
  assert.strictEqual(turnCompletedEvent.type, "turn.completed");
  const usage = turnCompletedEvent.usage;
  assert.ok(usage);
  assert.strictEqual(typeof usage.input_tokens, "number");
  assert.strictEqual(typeof usage.cached_input_tokens, "number");
  assert.strictEqual(typeof usage.cache_write_input_tokens, "number");
  assert.strictEqual(typeof usage.output_tokens, "number");
  assert.strictEqual(typeof usage.reasoning_output_tokens, "number");

  // Output file exists and matches item text
  assert.ok(fs.existsSync(outPath));
  const fileContent = fs.readFileSync(outPath, "utf8");
  assert.strictEqual(fileContent, itemEvent.item?.text);

  // Validates against plannerOutputSchema
  const parsedJson = JSON.parse(fileContent);
  const validation = plannerOutputSchema.safeParse(parsedJson);
  assert.strictEqual(validation.success, true);
  if (validation.success) {
    assert.ok(validation.data.task.length > 0);
    assert.ok(validation.data.scope_paths.length > 0);
    assert.ok(validation.data.acceptance.length > 0);
    assert.ok(validation.data.checks.length > 0);
  }

  // Worktree directory is never modified
  assert.strictEqual(fs.readdirSync(worktreeDir).length, 0);
});

test("fake codex: review-approve scenario emits valid events and validates against reviewerOutputSchema", () => {
  const outPath = path.join(tempDir, "review-approve-out.json");
  const worktreeDir = path.join(tempDir, "worktree-review-approve");
  fs.mkdirSync(worktreeDir, { recursive: true });

  const res = runFakeCodex(
    [
      "exec",
      "-",
      "--json",
      "-o",
      outPath,
      "-m",
      "GPT-6.1 Sol",
      "-c",
      "model_reasoning_effort=medium",
      "-s",
      "read-only",
      "-C",
      worktreeDir,
      "--ignore-user-config",
    ],
    {
      env: { FAKE_CODEX_SCENARIO: "review-approve" },
      input: "Review the code",
    },
  );

  assert.strictEqual(res.status, 0);
  const lines = res.stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  assert.strictEqual(lines.length, 4);

  const threadEvent = JSON.parse(lines[0]!);
  assert.strictEqual(threadEvent.thread_id, "fake-thread-review-approve");

  const itemEvent = JSON.parse(lines[2]!);
  assert.strictEqual(itemEvent.item?.type, "agent_message");

  assert.ok(fs.existsSync(outPath));
  const fileContent = fs.readFileSync(outPath, "utf8");
  assert.strictEqual(fileContent, itemEvent.item?.text);

  const parsedJson = JSON.parse(fileContent);
  const validation = reviewerOutputSchema.safeParse(parsedJson);
  assert.strictEqual(validation.success, true);
  if (validation.success) {
    assert.strictEqual(validation.data.verdict, "approve");
    assert.strictEqual(validation.data.findings.length, 0);
  }

  assert.strictEqual(fs.readdirSync(worktreeDir).length, 0);
});

test("fake codex: review-request-changes scenario validates with an actionable P1 finding", () => {
  const outPath = path.join(tempDir, "review-request-changes-out.json");
  const worktreeDir = path.join(tempDir, "worktree-review-changes");
  fs.mkdirSync(worktreeDir, { recursive: true });

  const res = runFakeCodex(
    [
      "exec",
      "-",
      "--json",
      "-o",
      outPath,
      "-m",
      "GPT-6.1 Sol",
      "-s",
      "read-only",
      "-C",
      worktreeDir,
      "--ignore-user-config",
    ],
    {
      env: { FAKE_CODEX_SCENARIO: "review-request-changes" },
      input: "Review the code",
    },
  );

  assert.strictEqual(res.status, 0);
  const lines = res.stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  assert.strictEqual(lines.length, 4);

  const threadEvent = JSON.parse(lines[0]!);
  assert.strictEqual(
    threadEvent.thread_id,
    "fake-thread-review-request-changes",
  );

  assert.ok(fs.existsSync(outPath));
  const fileContent = fs.readFileSync(outPath, "utf8");
  const parsedJson = JSON.parse(fileContent);
  const validation = reviewerOutputSchema.safeParse(parsedJson);
  assert.strictEqual(validation.success, true);
  if (validation.success) {
    assert.strictEqual(validation.data.verdict, "request_changes");
    assert.strictEqual(validation.data.findings.length, 1);
    const finding = validation.data.findings[0]!;
    assert.strictEqual(finding.severity, "P1");
    assert.strictEqual(finding.actionable, true);
    assert.strictEqual(typeof finding.path, "string");
    assert.strictEqual(typeof finding.line, "number");
    assert.ok(finding.line! >= 1);
  }

  assert.strictEqual(fs.readdirSync(worktreeDir).length, 0);
});

test("fake codex: plan-malformed scenario outputs non-JSON and fails schema validation", () => {
  const outPath = path.join(tempDir, "plan-malformed-out.json");
  const res = runFakeCodex(["exec", "-", "--json", "-o", outPath], {
    env: { FAKE_CODEX_SCENARIO: "plan-malformed" },
    input: "Plan task",
  });

  assert.strictEqual(res.status, 0);
  const lines = res.stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  assert.strictEqual(lines.length, 4);

  const threadEvent = JSON.parse(lines[0]!);
  assert.strictEqual(threadEvent.thread_id, "fake-thread-plan-malformed");

  const itemEvent = JSON.parse(lines[2]!);
  assert.throws(() => JSON.parse(itemEvent.item?.text), /SyntaxError/);

  assert.ok(fs.existsSync(outPath));
  const fileContent = fs.readFileSync(outPath, "utf8");
  assert.strictEqual(fileContent, itemEvent.item?.text);
  assert.throws(() => JSON.parse(fileContent), /SyntaxError/);
});

test("fake codex: review-malformed scenario outputs non-JSON and fails schema validation", () => {
  const outPath = path.join(tempDir, "review-malformed-out.json");
  const res = runFakeCodex(["exec", "-", "--json", "-o", outPath], {
    env: { FAKE_CODEX_SCENARIO: "review-malformed" },
    input: "Review task",
  });

  assert.strictEqual(res.status, 0);
  const lines = res.stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  assert.strictEqual(lines.length, 4);

  const threadEvent = JSON.parse(lines[0]!);
  assert.strictEqual(threadEvent.thread_id, "fake-thread-review-malformed");

  const itemEvent = JSON.parse(lines[2]!);
  assert.throws(() => JSON.parse(itemEvent.item?.text), /SyntaxError/);

  assert.ok(fs.existsSync(outPath));
  const fileContent = fs.readFileSync(outPath, "utf8");
  assert.strictEqual(fileContent, itemEvent.item?.text);
  assert.throws(() => JSON.parse(fileContent), /SyntaxError/);
});

test("fake codex: review-missing scenario emits success events but writes no output file", () => {
  const outPath = path.join(tempDir, "review-missing-out.json");
  const res = runFakeCodex(["exec", "-", "--json", "-o", outPath], {
    env: { FAKE_CODEX_SCENARIO: "review-missing" },
    input: "Review task",
  });

  assert.strictEqual(res.status, 0);
  const lines = res.stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  assert.strictEqual(lines.length, 4);

  const threadEvent = JSON.parse(lines[0]!);
  assert.strictEqual(threadEvent.thread_id, "fake-thread-review-missing");

  assert.strictEqual(fs.existsSync(outPath), false);
});

test("fake codex: hang scenario waits indefinitely and is killed", async () => {
  const child = spawn(
    process.execPath,
    [FIXTURE_PATH, "exec", "-", "--json"],
    {
      env: { ...process.env, FAKE_CODEX_SCENARIO: "hang" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.end();

  let stdoutData = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutData += chunk;
  });

  // Wait until thread.started event appears
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timeout waiting for hang thread.started"));
    }, 5000);

    const check = () => {
      if (stdoutData.includes("fake-thread-hang")) {
        clearTimeout(timer);
        resolve();
      } else {
        setTimeout(check, 25);
      }
    };
    check();
  });

  // Confirm child is still running
  assert.strictEqual(child.exitCode, null);

  // Kill child
  child.kill();

  // Wait for child to exit
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve();
    }, 2000);
    child.on("close", () => {
      clearTimeout(t);
      resolve();
    });
  });

  assert.notStrictEqual(child.exitCode, 0);
});

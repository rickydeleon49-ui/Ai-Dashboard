#!/usr/bin/env node
/**
 * Fake Codex CLI fixture for automated testing (§3.1, §16.2 row 8).
 *
 * Implements the non-interactive `codex exec` subset used by the Codex adapter:
 *   - Parses: `exec` (must be first), `-`, `--json`, `--output-schema <file>`,
 *     `-o`/`--output-last-message <file>`, `-m <model>`, `-c key=value`,
 *     `-s <mode>`, `-C <dir>`, `--ignore-user-config`.
 *   - Probes: `--version` ("codex-cli 0.160.0-fake"), `login status`.
 *   - Refuses denylisted flags with exit code 3.
 *   - Unknown flags/commands exit with code 2.
 *   - Scenarios via FAKE_CODEX_SCENARIO (default "plan-valid"):
 *       plan-valid, review-approve, review-request-changes,
 *       plan-malformed, review-malformed, review-missing,
 *       bad-effort, hang.
 *   - Writes only to the `-o` file; never touches the `-C` directory.
 */
import fs from "node:fs";
import path from "node:path";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function checkRefusedFlags(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (
      arg === "--dangerously-bypass-approvals-and-sandbox" ||
      arg.startsWith("--dangerously-bypass-approvals-and-sandbox=")
    ) {
      process.stderr.write(
        "fake-codex: refused flag --dangerously-bypass-approvals-and-sandbox\n",
      );
      process.exit(3);
    }
    if (
      arg === "--dangerously-bypass-hook-trust" ||
      arg.startsWith("--dangerously-bypass-hook-trust=")
    ) {
      process.stderr.write(
        "fake-codex: refused flag --dangerously-bypass-hook-trust\n",
      );
      process.exit(3);
    }
    if (
      arg === "--approve-for-me" ||
      arg.startsWith("--approve-for-me=")
    ) {
      process.stderr.write("fake-codex: refused flag --approve-for-me\n");
      process.exit(3);
    }
    if (
      arg === "--ignore-rules" ||
      arg.startsWith("--ignore-rules=")
    ) {
      process.stderr.write("fake-codex: refused flag --ignore-rules\n");
      process.exit(3);
    }
    if (
      (arg === "-s" || arg === "--sandbox") &&
      args[i + 1] === "danger-full-access"
    ) {
      process.stderr.write("fake-codex: refused flag -s danger-full-access\n");
      process.exit(3);
    }
    if (
      arg === "-s=danger-full-access" ||
      arg === "--sandbox=danger-full-access"
    ) {
      process.stderr.write("fake-codex: refused flag -s danger-full-access\n");
      process.exit(3);
    }
  }
}

function main() {
  const args = process.argv.slice(2);

  // 1. Refused flags always fail with exit 3
  checkRefusedFlags(args);

  // 2. Version probe
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write("codex-cli 0.160.0-fake\n");
    process.exit(0);
  }

  // 3. Login status probe
  if (args[0] === "login") {
    if (args.length === 2 && args[1] === "status") {
      if (process.env.FAKE_CODEX_LOGGED_OUT === "1") {
        process.stdout.write("Not logged in\n");
        process.exit(1);
      }
      process.stdout.write("Logged in using ChatGPT\n");
      process.exit(0);
    }
    process.stderr.write(`fake-codex: unknown command: ${args.join(" ")}\n`);
    process.exit(2);
  }

  // 4. Exec command must be first
  if (args.length === 0) {
    process.stderr.write("fake-codex: missing command\n");
    process.exit(2);
  }

  if (args[0] !== "exec") {
    if (args[0].startsWith("-")) {
      process.stderr.write(`fake-codex: unknown flag ${args[0]}\n`);
    } else {
      process.stderr.write(`fake-codex: unknown command ${args[0]}\n`);
    }
    process.exit(2);
  }

  // 5. Parse exec arguments
  const execArgs = args.slice(1);
  let hasStdin = false;
  let jsonMode = false;
  let outputSchema = null;
  let outputLastMessage = null;
  let model = null;
  const configs = {};
  let sandbox = null;
  let cdDir = null;
  let ignoreUserConfig = false;

  for (let i = 0; i < execArgs.length; i++) {
    const arg = execArgs[i];
    if (arg === "-") {
      hasStdin = true;
    } else if (arg === "--json") {
      jsonMode = true;
    } else if (arg === "--ignore-user-config") {
      ignoreUserConfig = true;
    } else if (arg === "--output-schema") {
      i++;
      if (i >= execArgs.length) {
        process.stderr.write("fake-codex: missing argument for --output-schema\n");
        process.exit(2);
      }
      outputSchema = execArgs[i];
    } else if (arg.startsWith("--output-schema=")) {
      outputSchema = arg.slice("--output-schema=".length);
    } else if (arg === "-o" || arg === "--output-last-message") {
      i++;
      if (i >= execArgs.length) {
        process.stderr.write(`fake-codex: missing argument for ${arg}\n`);
        process.exit(2);
      }
      outputLastMessage = execArgs[i];
    } else if (arg.startsWith("-o=")) {
      outputLastMessage = arg.slice("-o=".length);
    } else if (arg.startsWith("--output-last-message=")) {
      outputLastMessage = arg.slice("--output-last-message=".length);
    } else if (arg === "-m" || arg === "--model") {
      i++;
      if (i >= execArgs.length) {
        process.stderr.write(`fake-codex: missing argument for ${arg}\n`);
        process.exit(2);
      }
      model = execArgs[i];
    } else if (arg.startsWith("-m=")) {
      model = arg.slice("-m=".length);
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
    } else if (arg === "-c" || arg === "--config") {
      i++;
      if (i >= execArgs.length) {
        process.stderr.write(`fake-codex: missing argument for ${arg}\n`);
        process.exit(2);
      }
      const pair = execArgs[i];
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) {
        process.stderr.write(`fake-codex: invalid config format: ${pair}\n`);
        process.exit(2);
      }
      const key = pair.slice(0, eqIdx).trim();
      let val = pair.slice(eqIdx + 1).trim();
      val = val.replace(/^["']|["']$/g, "");
      configs[key] = val;
    } else if (arg.startsWith("-c=")) {
      const pair = arg.slice("-c=".length);
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) {
        process.stderr.write(`fake-codex: invalid config format: ${pair}\n`);
        process.exit(2);
      }
      const key = pair.slice(0, eqIdx).trim();
      let val = pair.slice(eqIdx + 1).trim();
      val = val.replace(/^["']|["']$/g, "");
      configs[key] = val;
    } else if (arg.startsWith("--config=")) {
      const pair = arg.slice("--config=".length);
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) {
        process.stderr.write(`fake-codex: invalid config format: ${pair}\n`);
        process.exit(2);
      }
      const key = pair.slice(0, eqIdx).trim();
      let val = pair.slice(eqIdx + 1).trim();
      val = val.replace(/^["']|["']$/g, "");
      configs[key] = val;
    } else if (arg === "-s" || arg === "--sandbox") {
      i++;
      if (i >= execArgs.length) {
        process.stderr.write(`fake-codex: missing argument for ${arg}\n`);
        process.exit(2);
      }
      sandbox = execArgs[i];
    } else if (arg.startsWith("-s=")) {
      sandbox = arg.slice("-s=".length);
    } else if (arg.startsWith("--sandbox=")) {
      sandbox = arg.slice("--sandbox=".length);
    } else if (arg === "-C" || arg === "--cd") {
      i++;
      if (i >= execArgs.length) {
        process.stderr.write(`fake-codex: missing argument for ${arg}\n`);
        process.exit(2);
      }
      cdDir = execArgs[i];
    } else if (arg.startsWith("-C=")) {
      cdDir = arg.slice("-C=".length);
    } else if (arg.startsWith("--cd=")) {
      cdDir = arg.slice("--cd=".length);
    } else {
      if (arg.startsWith("-")) {
        process.stderr.write(`fake-codex: unknown flag ${arg}\n`);
      } else {
        process.stderr.write(`fake-codex: unexpected argument ${arg}\n`);
      }
      process.exit(2);
    }
  }

  // 6. Read stdin prompt if `-` specified
  let stdinPrompt = "";
  if (hasStdin) {
    try {
      if (!process.stdin.isTTY) {
        stdinPrompt = fs.readFileSync(0, "utf8");
      }
    } catch {
      // Stdin might already be closed or empty
    }
  }

  void jsonMode;
  void outputSchema;
  void model;
  void sandbox;
  void cdDir;
  void ignoreUserConfig;
  void stdinPrompt;

  const scenario = process.env.FAKE_CODEX_SCENARIO || "plan-valid";

  // 7. Effort check (applied in every scenario, not only bad-effort)
  const VALID_EFFORTS = new Set([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);

  const effort = configs["model_reasoning_effort"];
  const isInvalidEffort = effort !== undefined && !VALID_EFFORTS.has(effort);

  if (scenario === "bad-effort" || isInvalidEffort) {
    const invalidValue = isInvalidEffort ? effort : (effort || "banana");
    const serviceError = JSON.stringify({
      error: {
        message: `Invalid value '${invalidValue}'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'.`,
      },
    });
    emit({ type: "error", message: serviceError });
    emit({ type: "turn.failed", error: { message: serviceError } });
    process.exitCode = 1;
    return;
  }

  // 8. Hang scenario
  if (scenario === "hang") {
    emit({
      type: "thread.started",
      thread_id: "fake-thread-hang",
    });
    setInterval(() => {}, 60000);
    return;
  }

  // 9. Scenarios generating results
  const usage = {
    input_tokens: 19000,
    cached_input_tokens: 13000,
    cache_write_input_tokens: 0,
    output_tokens: 500,
    reasoning_output_tokens: 200,
  };

  let resultText = "";
  let shouldWriteOutput = true;

  if (scenario === "plan-valid") {
    resultText = JSON.stringify(
      {
        task: "Implement fake codex fixture and unit tests",
        scope_paths: [
          "tests/fixtures/fake-codex.mjs",
          "tests/unit/agent-fake-codex.test.ts",
        ],
        acceptance: [
          "Fixture parses Codex CLI arguments accurately",
          "All scenarios emit valid JSONL and output files",
          "Unit tests pass",
        ],
        checks: ["typecheck", "lint", "test:unit"],
      },
      null,
      2,
    );
  } else if (scenario === "review-approve") {
    resultText = JSON.stringify(
      {
        verdict: "approve",
        findings: [],
      },
      null,
      2,
    );
  } else if (scenario === "review-request-changes") {
    resultText = JSON.stringify(
      {
        verdict: "request_changes",
        findings: [
          {
            severity: "P1",
            path: "src/example.ts",
            line: 42,
            message: "Missing validation check on input parameters",
            actionable: true,
          },
        ],
      },
      null,
      2,
    );
  } else if (scenario === "plan-malformed") {
    resultText = "Plan output malformed: this text is not JSON.";
  } else if (scenario === "review-malformed") {
    resultText = "Review output malformed: this text is not JSON.";
  } else if (scenario === "review-missing") {
    resultText = JSON.stringify(
      {
        verdict: "approve",
        findings: [],
      },
      null,
      2,
    );
    shouldWriteOutput = false;
  } else {
    process.stderr.write(`fake-codex: unknown scenario: ${scenario}\n`);
    process.exitCode = 1;
    return;
  }

  emit({
    type: "thread.started",
    thread_id: `fake-thread-${scenario}`,
  });

  emit({
    type: "turn.started",
  });

  emit({
    type: "item.completed",
    item: {
      id: "item_01",
      type: "agent_message",
      text: resultText,
    },
  });

  emit({
    type: "turn.completed",
    usage,
  });

  if (shouldWriteOutput && outputLastMessage) {
    const dir = path.dirname(outputLastMessage);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputLastMessage, resultText, "utf8");
  }

  process.exitCode = 0;
}

main();

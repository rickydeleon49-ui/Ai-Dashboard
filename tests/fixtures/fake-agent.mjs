#!/usr/bin/env node
/**
 * Fake agent fixture emitting Claude-style stream-json lines (§8, §14, §15 step 8).
 *
 * Scenarios:
 *   - success: init, text, tool_use/tool_result pair, writes fake-output.txt in cwd, result success.
 *   - fail: result with is_error: true, exit code 1.
 *   - hang: init, then waits forever.
 *   - noisy: 2000 lines of text, result success.
 *   - edit-excluded: writes secrets/leak.txt, result success.
 *   - malformed: prints a non-JSON line between valid ones, result success.
 */
import fs from "node:fs";
import path from "node:path";

let prompt = "";
try {
  if (!process.stdin.isTTY) {
    prompt = fs.readFileSync(0, "utf8");
  }
} catch {
  // Stdin might already be closed or empty
}

const scenario =
  process.env.FAKE_AGENT_SCENARIO || process.argv[2] || "success";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

if (scenario === "success") {
  emit({
    type: "system",
    subtype: "init",
    session_id: "fake-session-success",
    model: "claude-sonnet-5-5",
    tools: ["Read", "Edit", "Write", "Glob", "Grep"],
  });

  emit({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "Creating fake-output.txt now." }],
    },
  });

  emit({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_01",
          name: "Write",
          input: {
            file: "fake-output.txt",
            content: "fake agent created this file\n",
          },
        },
      ],
    },
  });

  // Write or edit fake-output.txt in cwd
  fs.writeFileSync(
    path.join(process.cwd(), "fake-output.txt"),
    "fake agent created this file\n",
    "utf8",
  );

  emit({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          is_error: false,
          content: "File fake-output.txt written successfully.",
        },
      ],
    },
  });

  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Successfully created fake-output.txt",
    session_id: "fake-session-success",
    num_turns: 1,
    duration_ms: 120,
    total_cost_usd: 0.001,
  });

  process.exitCode = 0; // not process.exit(): lets piped stdout drain (Linux pipes are async)
} else if (scenario === "fail") {
  emit({
    type: "result",
    subtype: "error",
    is_error: true,
    result: "Failed execution as requested by scenario",
    session_id: "fake-session-fail",
    num_turns: 1,
    duration_ms: 50,
    total_cost_usd: 0,
  });

  process.exitCode = 1; // not process.exit(): lets piped stdout drain (Linux pipes are async)
} else if (scenario === "hang") {
  emit({
    type: "system",
    subtype: "init",
    session_id: "fake-session-hang",
    model: "claude-sonnet-5-5",
    tools: [],
  });

  // Wait forever until stopped by process manager
  setInterval(() => {}, 60000);
} else if (scenario === "noisy") {
  emit({
    type: "system",
    subtype: "init",
    session_id: "fake-session-noisy",
    model: "claude-sonnet-5-5",
    tools: [],
  });

  for (let i = 0; i < 2000; i++) {
    emit({
      type: "assistant",
      message: {
        content: [{ type: "text", text: `noisy log line ${i}` }],
      },
    });
  }

  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Completed noisy scenario",
    session_id: "fake-session-noisy",
    num_turns: 1,
    duration_ms: 250,
    total_cost_usd: 0.005,
  });

  process.exitCode = 0; // not process.exit(): lets piped stdout drain (Linux pipes are async)
} else if (scenario === "edit-excluded") {
  const secretsDir = path.join(process.cwd(), "secrets");
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.writeFileSync(path.join(secretsDir, "leak.txt"), "leaked data\n", "utf8");

  emit({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_leak",
          name: "Write",
          input: { file: "secrets/leak.txt", content: "leaked data\n" },
        },
      ],
    },
  });

  emit({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_leak",
          is_error: false,
          content: "File secrets/leak.txt written.",
        },
      ],
    },
  });

  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Wrote secrets/leak.txt",
    session_id: "fake-session-leak",
    num_turns: 1,
    duration_ms: 100,
    total_cost_usd: 0,
  });

  process.exitCode = 0; // not process.exit(): lets piped stdout drain (Linux pipes are async)
} else if (scenario === "malformed") {
  emit({
    type: "system",
    subtype: "init",
    session_id: "fake-session-malformed",
    model: "claude-sonnet-5-5",
    tools: [],
  });

  // Non-JSON line
  process.stdout.write("this is not a valid json line at all!\n");

  emit({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "Recovered from malformed line." }],
    },
  });

  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Completed after malformed line",
    session_id: "fake-session-malformed",
    num_turns: 1,
    duration_ms: 80,
    total_cost_usd: 0.001,
  });

  process.exitCode = 0; // not process.exit(): lets piped stdout drain (Linux pipes are async)
} else {
  process.stderr.write(`Unknown scenario: ${scenario}\n`);
  process.exitCode = 1; // not process.exit(): lets piped stdout drain (Linux pipes are async)
}

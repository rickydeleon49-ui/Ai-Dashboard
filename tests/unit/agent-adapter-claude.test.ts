import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertNoBypass,
  buildClaudeInvocation,
  buildClaudeEnv,
  claudeAdapter,
  DENIED_FLAGS,
  probeClaudeCode,
} from "../../src/core/agents/adapters/claude-code";
import { EFFORT_LEVELS } from "../../src/core/agents/types";
import type {
  InvocationRequest,
  NormalizedEvent,
} from "../../src/core/agents/adapters/types";

test("claude-code adapter: argv contains the required flags in order and prompt is never in argv", () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "claude-adapter-test-"),
  );
  try {
    const workspacePath = path.join(tempRoot, "workspace");
    const grantDir = path.join(tempRoot, "grants");
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.mkdirSync(grantDir, { recursive: true });

    const req: InvocationRequest = {
      workspacePath,
      prompt: "Fix the edge case in parseLine",
      model: "claude-3-5-sonnet-20241022",
      effort: "medium",
      checkCommands: [["npm", "test"]],
      excludedPaths: ["secrets/**"],
      grantDir,
      resumeSessionId: "123e4567-e89b-12d3-a456-426614174000",
    };

    const inv = claudeAdapter.buildInvocation(req);

    const expectedOrder = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "default",
      "--setting-sources",
      "",
      "--settings",
      path.join(grantDir, "claude-settings.json"),
      "--add-dir",
      workspacePath,
      "--no-session-persistence",
      "--strict-mcp-config",
      "--model",
      "claude-3-5-sonnet-20241022",
      "--effort",
      "medium",
      "--resume",
      "123e4567-e89b-12d3-a456-426614174000",
    ];

    // Verify relative ordering of flags
    let lastIndex = -1;
    for (const flag of expectedOrder) {
      const idx = inv.args.indexOf(flag, lastIndex + 1);
      assert.ok(
        idx > lastIndex,
        `Expected flag "${flag}" to appear after index ${lastIndex}, found at ${idx}`,
      );
      lastIndex = idx;
    }

    // Prompt is sent via stdin, NEVER in argv
    assert.strictEqual(inv.args.includes(req.prompt), false);
    assert.strictEqual(inv.stdin, req.prompt);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("claude-code adapter: no bypass flag can be produced, even when model or effort injects one", () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "claude-adapter-bypass-"),
  );
  try {
    const workspacePath = path.join(tempRoot, "workspace");
    const grantDir = path.join(tempRoot, "grants");
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.mkdirSync(grantDir, { recursive: true });

    const baseReq: InvocationRequest = {
      workspacePath,
      prompt: "Safe task",
      checkCommands: [],
      excludedPaths: [],
      grantDir,
    };

    assert.throws(
      () =>
        claudeAdapter.buildInvocation({
          ...baseReq,
          model: "--dangerously-skip-permissions",
        }),
      /Invalid (model|effort)/,
    );

    assert.throws(
      () =>
        claudeAdapter.buildInvocation({
          ...baseReq,
          effort: "--dangerously-skip-permissions",
        }),
      /Invalid (model|effort)/,
    );

    assert.throws(
      () =>
        claudeAdapter.buildInvocation({
          ...baseReq,
          model: "--allow-dangerously-skip-permissions",
        }),
      /Invalid (model|effort)/,
    );

    assert.throws(
      () =>
        claudeAdapter.buildInvocation({
          ...baseReq,
          model: "--permission-mode bypassPermissions",
        }),
      /Invalid (model|effort)/,
    );

    assert.throws(
      () =>
        claudeAdapter.buildInvocation({
          ...baseReq,
          model: "claude-3-5 --dangerously-skip-permissions",
        }),
      /Invalid (model|effort)/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("claude-code adapter: assertNoBypass throws on each denied flag", () => {
  for (const flag of DENIED_FLAGS) {
    assert.throws(
      () => assertNoBypass([flag]),
      /Denied bypass flag/,
      `assertNoBypass should throw on ${flag}`,
    );
  }

  assert.throws(
    () => assertNoBypass(["--permission-mode", "bypassPermissions"]),
    /Denied bypass flag/,
  );
  assert.throws(
    () => assertNoBypass(["--dangerously-skip-permissions=true"]),
    /Denied bypass flag/,
  );
  assert.throws(
    () => assertNoBypass(["--allow-dangerously-skip-permissions=true"]),
    /Denied bypass flag/,
  );
  assert.throws(
    () => assertNoBypass(["bypassPermissions"]),
    /Denied bypass flag/,
  );

  // Safe argument lists must not throw
  assert.doesNotThrow(() =>
    assertNoBypass(["-p", "--verbose", "--model", "claude-3-5-sonnet"]),
  );
});

test("claude-code adapter: grant file written in grantDir with allow/deny lists, and shell metacharacters refused", () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "claude-adapter-grant-"),
  );
  try {
    const workspacePath = path.join(tempRoot, "workspace");
    const grantDir = path.join(tempRoot, "grants");
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.mkdirSync(grantDir, { recursive: true });

    const req: InvocationRequest = {
      workspacePath,
      prompt: "Safe task",
      checkCommands: [
        ["npm", "test"],
        ["npm", "run", "lint"],
      ],
      excludedPaths: ["secrets/**", "config/*.key"],
      grantDir,
    };

    claudeAdapter.buildInvocation(req);

    const grantPath = path.join(grantDir, "claude-settings.json");
    assert.ok(fs.existsSync(grantPath));

    const settings = JSON.parse(fs.readFileSync(grantPath, "utf8"));
    assert.deepEqual(settings.permissions.allow, [
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "Bash(npm test)",
      "Bash(npm run lint)",
    ]);

    assert.deepEqual(settings.permissions.deny, [
      "Bash(git push:*)",
      "Bash(git merge:*)",
      "Bash(git remote:*)",
      "Bash(npm publish:*)",
      "Bash(curl:*)",
      "Bash(wget:*)",
      "WebFetch",
      "WebSearch",
      "Read(secrets/**)",
      "Edit(secrets/**)",
      "Write(secrets/**)",
      "Read(config/*.key)",
      "Edit(config/*.key)",
      "Write(config/*.key)",
    ]);

    // Refusal of commands with shell metacharacters (; && | ` $ < > ( ) { } \r \n)
    const badCommands = [
      ["npm", "test; rm -rf /"],
      ["npm", "test", "&&", "build"],
      ["npm", "test", "|", "grep fail"],
      ["echo", "`whoami`"],
      ["echo", "$(id)"],
      ["cat", "<input"],
      ["echo", ">output"],
      ["run", "{a,b}"],
      ["echo", "line1\nline2"],
      ["echo", "line1\rline2"],
    ];

    for (const cmd of badCommands) {
      assert.throws(
        () =>
          claudeAdapter.buildInvocation({
            ...req,
            checkCommands: [cmd],
          }),
        /Check command contains forbidden shell metacharacter/,
        `Should reject command containing metacharacters: ${JSON.stringify(cmd)}`,
      );
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("claude-code adapter: grantDir inside workspace is refused", () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "claude-adapter-containment-"),
  );
  try {
    const workspacePath = path.join(tempRoot, "workspace");
    fs.mkdirSync(workspacePath, { recursive: true });

    const insideGrant = path.join(workspacePath, "grants");
    const req: InvocationRequest = {
      workspacePath,
      prompt: "Safe task",
      checkCommands: [],
      excludedPaths: [],
      grantDir: insideGrant,
    };

    assert.throws(
      () => claudeAdapter.buildInvocation(req),
      /grantDir cannot be inside workspacePath/,
    );

    assert.throws(
      () =>
        claudeAdapter.buildInvocation({
          ...req,
          grantDir: workspacePath,
        }),
      /grantDir cannot be inside workspacePath/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("claude-code adapter: env allowlist drops secrets and keeps PATH and auth variables", () => {
  const baseEnv: Record<string, string | undefined> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    Path: "C:\\Windows\\System32;C:\\Windows",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SystemRoot: "C:\\Windows",
    SYSTEMROOT: "C:\\Windows",
    windir: "C:\\Windows",
    COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    TEMP: "C:\\Temp",
    TMP: "C:\\Temp",
    HOME: "/home/user",
    USERPROFILE: "C:\\Users\\user",
    APPDATA: "C:\\Users\\user\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\user\\AppData\\Local",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TERM: "xterm-256color",
    ANTHROPIC_API_KEY: "sk-ant-1234567890abcdef",
    CLAUDE_CODE_ENTRYPOINT: "cli.js",
    CLAUDE_CODE_SESSION_ID: "sess-123",
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/sock",
    CLAUDE_CODE_MESSAGING_TOKEN: "tok-abc",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CONFIG_DIR: "C:\cfg",
    HTTPS_PROXY: "http://proxy:8080",
    https_proxy: "http://proxy:8080",
    No_Proxy: "localhost",
    DESKTOP_INTERNAL_SECRET: "internal-secret-token",
    DATABASE_URL: "postgres://user:pass@localhost:5432/db",
    GITHUB_TOKEN: "ghp_secrettoken987654321",
    AWS_SECRET_ACCESS_KEY: "supersecret",
  };

  const filtered = buildClaudeEnv(baseEnv);

  // Kept
  assert.strictEqual(filtered.PATH, "/usr/local/bin:/usr/bin:/bin");
  assert.strictEqual(filtered.Path, "C:\\Windows\\System32;C:\\Windows");
  assert.strictEqual(filtered.PATHEXT, ".COM;.EXE;.BAT;.CMD");
  assert.strictEqual(filtered.SystemRoot, "C:\\Windows");
  assert.strictEqual(filtered.windir, "C:\\Windows");
  assert.strictEqual(filtered.ANTHROPIC_API_KEY, "sk-ant-1234567890abcdef");
  assert.strictEqual(filtered.CLAUDE_CODE_USE_BEDROCK, "1");
  assert.strictEqual(filtered.CLAUDE_CONFIG_DIR, "C:\cfg");
  assert.strictEqual(filtered.HTTPS_PROXY, "http://proxy:8080");
  assert.strictEqual(filtered.https_proxy, "http://proxy:8080");
  assert.strictEqual(filtered.No_Proxy, "localhost");
  assert.strictEqual(filtered.TERM, "xterm-256color");

  // Parent Claude Code session variables must never reach the agent
  assert.strictEqual(filtered.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.strictEqual(filtered.CLAUDE_CODE_SESSION_ID, undefined);
  assert.strictEqual(filtered.CLAUDE_CODE_MESSAGING_SOCKET, undefined);
  assert.strictEqual(filtered.CLAUDE_CODE_MESSAGING_TOKEN, undefined);

  // Dropped
  assert.strictEqual(filtered.DESKTOP_INTERNAL_SECRET, undefined);
  assert.strictEqual(filtered.DATABASE_URL, undefined);
  assert.strictEqual(filtered.GITHUB_TOKEN, undefined);
  assert.strictEqual(filtered.AWS_SECRET_ACCESS_KEY, undefined);
});

test("claude-code adapter: --resume is only added for a valid UUID", () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "claude-adapter-resume-"),
  );
  try {
    const workspacePath = path.join(tempRoot, "workspace");
    const grantDir = path.join(tempRoot, "grants");
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.mkdirSync(grantDir, { recursive: true });

    const baseReq: InvocationRequest = {
      workspacePath,
      prompt: "Resume test",
      checkCommands: [],
      excludedPaths: [],
      grantDir,
    };

    // Valid UUID format
    const validUuid = "9f8b4c2e-1a3d-4e5f-8a9b-0c1d2e3f4a5b";
    const invValid = claudeAdapter.buildInvocation({
      ...baseReq,
      resumeSessionId: validUuid,
    });
    assert.ok(invValid.args.includes("--resume"));
    const resumeIndex = invValid.args.indexOf("--resume");
    assert.strictEqual(invValid.args[resumeIndex + 1], validUuid);

    // Invalid session IDs
    const invalidSessionIds = [
      "not-a-uuid",
      "12345",
      "../escape",
      "9f8b4c2e-1a3d-4e5f-8a9b",
      "",
    ];
    for (const invalid of invalidSessionIds) {
      const invInvalid = claudeAdapter.buildInvocation({
        ...baseReq,
        resumeSessionId: invalid,
      });
      assert.strictEqual(
        invInvalid.args.includes("--resume"),
        false,
        `Expected --resume to be omitted for: ${invalid}`,
      );
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("claude-code adapter: parseLine handles stream-json types and malformed input gracefully", () => {
  // 1. system / init
  const sysEvents = claudeAdapter.parseLine({
    type: "system",
    subtype: "init",
    session_id: "sess_001",
    model: "claude-3-5-sonnet",
    tools: ["Read", "Edit"],
  });
  assert.deepEqual(sysEvents, [
    {
      agent: "implementer",
      kind: "output",
      payload: { sessionId: "sess_001", model: "claude-3-5-sonnet" },
    },
  ]);

  // 2. assistant text
  const textEvents = claudeAdapter.parseLine({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "Refactoring the logic" }],
    },
  });
  assert.deepEqual(textEvents, [
    {
      agent: "implementer",
      kind: "output",
      payload: { text: "Refactoring the logic" },
    },
  ]);

  // 3. assistant tool_use
  const toolUseEvents = claudeAdapter.parseLine({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "call_99",
          name: "Edit",
          input: { file: "test.ts" },
        },
      ],
    },
  });
  assert.deepEqual(toolUseEvents, [
    {
      agent: "implementer",
      kind: "tool_call",
      payload: {
        id: "call_99",
        name: "Edit",
        input: { file: "test.ts" },
      },
    },
  ]);

  // 4. user tool_result with content truncation to 4000 characters
  const longText = "a".repeat(5000);
  const toolResultEvents = claudeAdapter.parseLine({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_99",
          is_error: false,
          content: longText,
        },
      ],
    },
  });
  assert.strictEqual(toolResultEvents.length, 1);
  assert.strictEqual(toolResultEvents[0]?.kind, "tool_result");
  const toolResPayload = toolResultEvents[0]?.payload as {
    toolUseId: string;
    isError: boolean;
    content: string;
  };
  assert.strictEqual(toolResPayload.toolUseId, "call_99");
  assert.strictEqual(toolResPayload.isError, false);
  assert.strictEqual(toolResPayload.content.length, 4000);

  // 5. result event
  const resultEvents = claudeAdapter.parseLine({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "All done",
    session_id: "sess_001",
    num_turns: 4,
    duration_ms: 2500,
    total_cost_usd: 0.035,
  });
  assert.deepEqual(resultEvents, [
    {
      agent: "implementer",
      kind: "output",
      payload: {
        final: true,
        isError: false,
        subtype: "success",
        sessionId: "sess_001",
        numTurns: 4,
        durationMs: 2500,
        costUsd: 0.035,
        text: "All done",
      },
    },
  ]);

  // 6. Unknown and garbage shapes never throw
  assert.deepEqual(claudeAdapter.parseLine(null), []);
  assert.deepEqual(claudeAdapter.parseLine(undefined), []);
  assert.deepEqual(claudeAdapter.parseLine("plain string"), []);
  assert.deepEqual(claudeAdapter.parseLine(12345), []);
  assert.deepEqual(claudeAdapter.parseLine({}), []);
  assert.deepEqual(claudeAdapter.parseLine({ type: "unknown_future_type" }), []);
  assert.deepEqual(
    claudeAdapter.parseLine({ type: "system", subtype: "unsupported" }),
    [],
  );
  assert.deepEqual(
    claudeAdapter.parseLine({
      type: "assistant",
      message: { content: "not-an-array" },
    }),
    [],
  );
});

test("claude-code adapter: probe covers all status combinations via injected runner", async () => {
  const mockResolveSuccess = () =>
    ({
      ok: true,
      file: "/usr/local/bin/claude",
      prefixArgs: [],
      source: "/usr/local/bin/claude",
    }) as const;

  // 1. Installed and loggedIn = true
  const runnerLoggedIn = async (_file: string, args: string[]) => {
    if (args.includes("--version")) {
      return { stdout: "claude 2.1.312", stderr: "", exitCode: 0 };
    }
    if (args.includes("status")) {
      return {
        stdout: JSON.stringify({ loggedIn: true, account: "user@test.org" }),
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  const resLoggedIn = await probeClaudeCode({
    resolveExecutable: mockResolveSuccess as any,
    runner: runnerLoggedIn,
  });
  assert.strictEqual(resLoggedIn.installed, true);
  assert.strictEqual(resLoggedIn.authenticated, true);
  assert.strictEqual(resLoggedIn.version, "2.1.312");
  assert.strictEqual(resLoggedIn.executable, "/usr/local/bin/claude");

  // 2. Installed and loggedIn = false
  const runnerLoggedOut = async (_file: string, args: string[]) => {
    if (args.includes("--version")) {
      return { stdout: "2.1.312", stderr: "", exitCode: 0 };
    }
    if (args.includes("status")) {
      return {
        stdout: JSON.stringify({ loggedIn: false }),
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  const resLoggedOut = await probeClaudeCode({
    resolveExecutable: mockResolveSuccess as any,
    runner: runnerLoggedOut,
  });
  assert.strictEqual(resLoggedOut.installed, true);
  assert.strictEqual(resLoggedOut.authenticated, false);
  assert.strictEqual(resLoggedOut.version, "2.1.312");

  // 3. Not installed (tried list)
  const mockResolveNotFound = () =>
    ({
      ok: false,
      tried: ["C:\\Program Files\\npm\\claude.cmd", "C:\\bin\\claude.exe"],
    }) as const;

  const resNotFound = await probeClaudeCode({
    resolveExecutable: mockResolveNotFound as any,
  });
  assert.strictEqual(resNotFound.installed, false);
  assert.strictEqual(resNotFound.authenticated, "unknown");
  assert.deepEqual(resNotFound.tried, [
    "C:\\Program Files\\npm\\claude.cmd",
    "C:\\bin\\claude.exe",
  ]);

  // 4. Auth output that is not valid JSON -> "unknown"
  const runnerInvalidJson = async (_file: string, args: string[]) => {
    if (args.includes("--version")) {
      return { stdout: "claude 2.1.312", stderr: "", exitCode: 0 };
    }
    if (args.includes("status")) {
      return {
        stdout: "<html><body>Not JSON</body></html>",
        stderr: "",
        exitCode: 1,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  const resInvalidJson = await probeClaudeCode({
    resolveExecutable: mockResolveSuccess as any,
    runner: runnerInvalidJson,
  });
  assert.strictEqual(resInvalidJson.installed, true);
  assert.strictEqual(resInvalidJson.authenticated, "unknown");
  assert.strictEqual(resInvalidJson.version, "2.1.312");
});

function makeReq(tempRoot: string): InvocationRequest {
  const workspacePath = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspacePath, { recursive: true });
  return {
    workspacePath,
    prompt: "Task",
    checkCommands: [],
    excludedPaths: [],
    grantDir: path.join(tempRoot, "grants"),
  };
}

test("claude-code adapter: grantDir resolving inside workspace via junction/symlink is refused", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-adapter-link-"));
  try {
    const req = makeReq(tempRoot);
    const link = path.join(tempRoot, "linked-grants");
    fs.symlinkSync(req.workspacePath, link, "junction");

    // Existing link pointing into the workspace
    assert.throws(
      () => claudeAdapter.buildInvocation({ ...req, grantDir: link }),
      /grantDir cannot be inside workspacePath/,
    );
    // Non-existent child of the link: nearest existing ancestor resolves inside
    assert.throws(
      () =>
        claudeAdapter.buildInvocation({
          ...req,
          grantDir: path.join(link, "not", "yet"),
        }),
      /grantDir cannot be inside workspacePath/,
    );
    // Nothing was written into the workspace
    assert.deepEqual(fs.readdirSync(req.workspacePath), []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("claude-code adapter: unresolvable claude executable throws with tried paths", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-adapter-nores-"));
  try {
    const req = makeReq(tempRoot);
    assert.throws(
      () =>
        buildClaudeInvocation(req, {
          resolveExecutable: (() => ({
            ok: false,
            tried: ["/somewhere/claude.exe", "/nope/claude"],
          })) as never,
        }),
      /Could not resolve the claude executable.*somewhere.*\/nope\/claude/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("claude-code adapter: model and effort are validated", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-adapter-valid-"));
  try {
    const req = makeReq(tempRoot);
    const deps = { executableFile: "claude", baseEnv: {} };
    for (const model of [
      "--dangerously-skip-permissions",
      "-x",
      "a b",
      "model;rm",
      "",
      "a".repeat(101),
    ]) {
      if (model === "") continue; // empty means "not set"
      assert.throws(
        () => buildClaudeInvocation({ ...req, model }, deps),
        /Invalid model name/,
        `model ${JSON.stringify(model)}`,
      );
    }
    for (const effort of ["--dangerously-skip-permissions", "-x", "extreme", "LOW "]) {
      assert.throws(
        () => buildClaudeInvocation({ ...req, effort }, deps),
        /Invalid effort level/,
        `effort ${JSON.stringify(effort)}`,
      );
    }
    for (const model of ["claude-opus-4-1", "sonnet", "anthropic.claude-v2:1", "m[1m]"]) {
      assert.doesNotThrow(() => buildClaudeInvocation({ ...req, model }, deps));
    }
    for (const effort of EFFORT_LEVELS) {
      const inv = buildClaudeInvocation({ ...req, effort }, deps);
      assert.ok(inv.args.includes(effort));
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("claude-code adapter: final argv guard rejects bypass injected via prefixArgs", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-adapter-prefix-"));
  try {
    const req = makeReq(tempRoot);
    for (const prefixArgs of [
      ["--dangerously-skip-permissions"],
      ["--permission-mode", "bypassPermissions"],
    ]) {
      assert.throws(
        () =>
          buildClaudeInvocation(req, {
            executableFile: "claude",
            prefixArgs,
            baseEnv: {},
          }),
        /Denied bypass flag/,
      );
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

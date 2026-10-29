import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fakeAdapter } from "../../src/core/agents/adapters/fake";
import type {
  NormalizedEvent,
} from "../../src/core/agents/adapters/types";
import {
  spawnAgentProcess,
  stopAgentProcess,
} from "../../src/core/agents/process";

test("fake adapter probe: always reports installed and authenticated", async () => {
  const probe = await fakeAdapter.probe();
  assert.strictEqual(probe.installed, true);
  assert.strictEqual(probe.authenticated, true);
  assert.strictEqual(probe.version, "1.0.0");
  assert.strictEqual(probe.executable, process.execPath);
});

test("fake adapter scenarios in folder with spaces", async (t) => {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent test run with spaces "),
  );
  const grantDir = path.join(rootDir, "grants");
  fs.mkdirSync(grantDir, { recursive: true });

  try {
    // 1. Success scenario
    await t.test("scenario: success", async () => {
      const workspacePath = path.join(rootDir, "workspace success");
      fs.mkdirSync(workspacePath, { recursive: true });

      const inv = fakeAdapter.buildInvocation({
        workspacePath,
        prompt: "Run success scenario",
        model: "success",
        checkCommands: [],
        excludedPaths: [],
        grantDir,
      });

      const jsonValues: unknown[] = [];
      const textLines: string[] = [];

      const handle = spawnAgentProcess({
        file: inv.file,
        args: inv.args,
        cwd: inv.cwd,
        env: inv.env as NodeJS.ProcessEnv,
        stdin: inv.stdin,
        onJson: (val) => jsonValues.push(val),
        onText: (stream, txt) => textLines.push(`${stream}:${txt}`),
      });

      const exit = await handle.done;
      assert.strictEqual(exit.code, 0);
      assert.strictEqual(exit.stoppedByUs, false);

      // Verify file written in cwd
      const createdFile = path.join(workspacePath, "fake-output.txt");
      assert.ok(fs.existsSync(createdFile));
      assert.strictEqual(
        fs.readFileSync(createdFile, "utf8"),
        "fake agent created this file\n",
      );

      // Parse events through adapter
      const events: NormalizedEvent[] = jsonValues.flatMap((v) =>
        fakeAdapter.parseLine(v),
      );
      assert.strictEqual(events.length, 5);

      assert.strictEqual(events[0]?.kind, "output");
      assert.strictEqual(
        (events[0]?.payload as { sessionId: string }).sessionId,
        "fake-session-success",
      );

      assert.strictEqual(events[1]?.kind, "output");
      assert.strictEqual(
        (events[1]?.payload as { text: string }).text,
        "Creating fake-output.txt now.",
      );

      assert.strictEqual(events[2]?.kind, "tool_call");
      assert.strictEqual(
        (events[2]?.payload as { name: string }).name,
        "Write",
      );

      assert.strictEqual(events[3]?.kind, "tool_result");
      assert.strictEqual(
        (events[3]?.payload as { toolUseId: string }).toolUseId,
        "toolu_01",
      );
      assert.strictEqual(
        (events[3]?.payload as { isError: boolean }).isError,
        false,
      );

      assert.strictEqual(events[4]?.kind, "output");
      assert.strictEqual(
        (events[4]?.payload as { final: boolean }).final,
        true,
      );
      assert.strictEqual(
        (events[4]?.payload as { isError: boolean }).isError,
        false,
      );

      for (const ev of events) {
        assert.strictEqual(ev.agent, "implementer");
      }
    });

    // 2. Fail scenario
    await t.test("scenario: fail", async () => {
      const workspacePath = path.join(rootDir, "workspace fail");
      fs.mkdirSync(workspacePath, { recursive: true });

      const inv = fakeAdapter.buildInvocation({
        workspacePath,
        prompt: "Run fail scenario",
        model: "fail",
        checkCommands: [],
        excludedPaths: [],
        grantDir,
      });

      const jsonValues: unknown[] = [];
      const handle = spawnAgentProcess({
        file: inv.file,
        args: inv.args,
        cwd: inv.cwd,
        env: inv.env as NodeJS.ProcessEnv,
        stdin: inv.stdin,
        onJson: (val) => jsonValues.push(val),
      });

      const exit = await handle.done;
      assert.strictEqual(exit.code, 1);
      assert.strictEqual(exit.stoppedByUs, false);

      const events = jsonValues.flatMap((v) => fakeAdapter.parseLine(v));
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0]?.kind, "output");
      assert.strictEqual(
        (events[0]?.payload as { isError: boolean }).isError,
        true,
      );
      assert.strictEqual(
        (events[0]?.payload as { final: boolean }).final,
        true,
      );
    });

    // 3. Hang scenario stopped by stopAgentProcess
    await t.test("scenario: hang stopped by stopAgentProcess", async () => {
      const workspacePath = path.join(rootDir, "workspace hang");
      fs.mkdirSync(workspacePath, { recursive: true });

      const inv = fakeAdapter.buildInvocation({
        workspacePath,
        prompt: "Run hang scenario",
        model: "hang",
        checkCommands: [],
        excludedPaths: [],
        grantDir,
      });

      const jsonValues: unknown[] = [];
      const handle = spawnAgentProcess({
        file: inv.file,
        args: inv.args,
        cwd: inv.cwd,
        env: inv.env as NodeJS.ProcessEnv,
        stdin: inv.stdin,
        onJson: (val) => jsonValues.push(val),
      });

      // Wait until init event arrives
      const start = Date.now();
      while (jsonValues.length === 0 && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(jsonValues.length >= 1, "Expected init line from hang scenario");

      // Stop the process
      const exit = await stopAgentProcess(handle, { graceMs: 500 });
      assert.strictEqual(exit.stoppedByUs, true);
      assert.strictEqual(handle.exited, true);
    });

    // 4. Noisy scenario
    await t.test("scenario: noisy", async () => {
      const workspacePath = path.join(rootDir, "workspace noisy");
      fs.mkdirSync(workspacePath, { recursive: true });

      const inv = fakeAdapter.buildInvocation({
        workspacePath,
        prompt: "Run noisy scenario",
        model: "noisy",
        checkCommands: [],
        excludedPaths: [],
        grantDir,
      });

      const jsonValues: unknown[] = [];
      const handle = spawnAgentProcess({
        file: inv.file,
        args: inv.args,
        cwd: inv.cwd,
        env: inv.env as NodeJS.ProcessEnv,
        stdin: inv.stdin,
        onJson: (val) => jsonValues.push(val),
      });

      const exit = await handle.done;
      assert.strictEqual(exit.code, 0);

      const events = jsonValues.flatMap((v) => fakeAdapter.parseLine(v));
      // 1 init + 2000 text lines + 1 result = 2002 events
      assert.strictEqual(events.length, 2002);
      const finalEvent = events[events.length - 1];
      assert.strictEqual(
        (finalEvent?.payload as { final: boolean }).final,
        true,
      );
    });

    // 5. Edit-excluded scenario
    await t.test("scenario: edit-excluded", async () => {
      const workspacePath = path.join(rootDir, "workspace excluded");
      fs.mkdirSync(workspacePath, { recursive: true });

      const inv = fakeAdapter.buildInvocation({
        workspacePath,
        prompt: "Run edit-excluded scenario",
        model: "edit-excluded",
        checkCommands: [],
        excludedPaths: ["secrets/**"],
        grantDir,
      });

      const jsonValues: unknown[] = [];
      const handle = spawnAgentProcess({
        file: inv.file,
        args: inv.args,
        cwd: inv.cwd,
        env: inv.env as NodeJS.ProcessEnv,
        stdin: inv.stdin,
        onJson: (val) => jsonValues.push(val),
      });

      const exit = await handle.done;
      assert.strictEqual(exit.code, 0);

      const leakPath = path.join(workspacePath, "secrets", "leak.txt");
      assert.ok(fs.existsSync(leakPath));
      assert.strictEqual(fs.readFileSync(leakPath, "utf8"), "leaked data\n");

      const events = jsonValues.flatMap((v) => fakeAdapter.parseLine(v));
      const toolCall = events.find((e) => e.kind === "tool_call");
      assert.ok(toolCall);
      assert.strictEqual(
        (toolCall?.payload as { name: string }).name,
        "Write",
      );
    });

    // 6. Malformed scenario
    await t.test("scenario: malformed", async () => {
      const workspacePath = path.join(rootDir, "workspace malformed");
      fs.mkdirSync(workspacePath, { recursive: true });

      const inv = fakeAdapter.buildInvocation({
        workspacePath,
        prompt: "Run malformed scenario",
        model: "malformed",
        checkCommands: [],
        excludedPaths: [],
        grantDir,
      });

      const jsonValues: unknown[] = [];
      const textLines: string[] = [];

      const handle = spawnAgentProcess({
        file: inv.file,
        args: inv.args,
        cwd: inv.cwd,
        env: inv.env as NodeJS.ProcessEnv,
        stdin: inv.stdin,
        onJson: (val) => jsonValues.push(val),
        onText: (stream, txt) => textLines.push(`${stream}:${txt}`),
      });

      const exit = await handle.done;
      assert.strictEqual(exit.code, 0);

      // The non-JSON line is routed to onText
      assert.ok(
        textLines.some((line) =>
          line.includes("this is not a valid json line at all!"),
        ),
      );

      // The valid lines around it are still parsed
      const events = jsonValues.flatMap((v) => fakeAdapter.parseLine(v));
      assert.strictEqual(events.length, 3); // init, text, result
      assert.strictEqual(
        (events[events.length - 1]?.payload as { final: boolean }).final,
        true,
      );
    });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

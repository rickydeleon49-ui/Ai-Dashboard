import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  lineSplitter,
  spawnAgentProcess,
  stopAgentProcess,
  type AgentProcessHandle,
} from "../../src/core/agents/process";

const FIXTURE = path.resolve(process.cwd(), "tests", "fixtures", "agent-process-fixture.mjs");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function run(mode: string, args: string[] = [], extra: { json?: unknown[]; text?: string[] } = {}) {
  return spawnAgentProcess({
    file: process.execPath,
    args: [FIXTURE, mode, ...args],
    cwd: process.cwd(),
    env: process.env,
    onJson: (v) => extra.json?.push(v),
    onText: (s, t) => extra.text?.push(`${s}:${t}`),
  });
}

test("NDJSON is parsed across chunk boundaries; non-JSON and stderr arrive as text; exit code captured", async () => {
  const json: unknown[] = [];
  const text: string[] = [];
  const handle = run("lines", [], { json, text });
  assert.ok(typeof handle.pid === "number");
  const exit = await handle.done;
  assert.deepEqual(json, [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(text.sort(), ["stderr:oops", "stdout:not json"]);
  assert.equal(exit.code, 3);
  assert.equal(exit.stoppedByUs, false);
  if (process.platform !== "win32") assert.equal(handle.pgid, handle.pid);
});

test("argv with spaces, quotes and shell metacharacters reaches the child intact", async () => {
  const args = ['has space', 'say "hi"', "it's", "a&b|c;d", "%PATH%", "$HOME", ""];
  const json: unknown[] = [];
  const exit = await run("args", args, { json }).done;
  assert.equal(exit.code, 0);
  assert.deepEqual(json, [{ args }]);
});

test("a missing executable resolves done with an error instead of throwing", async () => {
  const handle = spawnAgentProcess({
    file: path.join(os.tmpdir(), "definitely-not-here-xyz"),
    args: [],
    cwd: process.cwd(),
  });
  const exit = await handle.done;
  assert.ok(exit.error);
  assert.equal(exit.code, null);
  const again = await stopAgentProcess(handle, { graceMs: 50 });
  assert.equal(again.stoppedByUs, false);
});

test("stop() kills the child and its grandchild", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-proc-"));
  const pidFile = path.join(dir, "gc.pid");
  let grandchild = 0;
  try {
    const handle = run("tree", [pidFile]);
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    grandchild = Number(readFileSync(pidFile, "utf8"));
    const child = handle.pid as number;
    assert.ok(alive(child) && alive(grandchild));

    const exit = await stopAgentProcess(handle, { graceMs: 400 });
    assert.equal(exit.stoppedByUs, true);
    assert.ok(!alive(child), "child should be gone");
    await waitFor(() => !alive(grandchild), 5_000).catch(() => undefined);
    assert.ok(!alive(grandchild), "grandchild must not survive stop()");
  } finally {
    if (grandchild && alive(grandchild)) {
      try {
        process.kill(grandchild, "SIGKILL");
      } catch {
        // already gone
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop() on an exited process is a no-op and never throws", async () => {
  const handle = run("exit", ["0"]);
  const exit = await handle.done;
  assert.equal(exit.code, 0);
  const again = await stopAgentProcess(handle, { graceMs: 50 });
  assert.deepEqual(again, exit);
  assert.equal(again.stoppedByUs, false);
});

test("stop() gives up with an error result when the process never exits", async () => {
  const calls: boolean[] = [];
  const fake = {
    pid: 4242,
    pgid: undefined,
    platform: "win32",
    child: {},
    stopRequested: false,
    exited: false,
    done: new Promise(() => {}),
  } as unknown as AgentProcessHandle;
  const exit = await stopAgentProcess(fake, {
    graceMs: 50,
    killer: async (_pid, force) => {
      calls.push(force);
    },
  });
  assert.deepEqual(calls, [false, true]);
  assert.deepEqual(exit, {
    code: null,
    signal: null,
    stoppedByUs: true,
    error: "process did not exit after stop",
  });
});

test("stop() after the parent exited still kills a surviving grandchild (POSIX)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-proc-"));
  const pidFile = path.join(dir, "gc.pid");
  let grandchild = 0;
  try {
    const handle = run("orphan", [pidFile]);
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    grandchild = Number(readFileSync(pidFile, "utf8"));
    await handle.done;
    assert.ok(alive(grandchild), "grandchild should outlive the parent");
    if (process.platform === "win32") {
      // Known limitation: taskkill /T cannot walk a tree whose root has
      // exited (design names a Job Object as the later fix). No assertion.
      return;
    }
    await stopAgentProcess(handle, { graceMs: 400 });
    await waitFor(() => !alive(grandchild), 5_000).catch(() => undefined);
    assert.ok(!alive(grandchild), "grandchild must not survive stop()");
  } finally {
    if (grandchild && alive(grandchild)) {
      try {
        process.kill(grandchild, "SIGKILL");
      } catch {
        // already gone
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stdout line that yields no JSON value is emitted as text, not dropped", async () => {
  const json: unknown[] = [];
  const text: string[] = [];
  await run("brace", [], { json, text }).done;
  assert.deepEqual(json, [{ ok: 1 }]);
  assert.deepEqual(text, ["stdout:{"]);
});

test("lineSplitter: a runaway line emits one head fragment, then the next line is normal", () => {
  const got: Array<[string, boolean]> = [];
  const s = lineSplitter(10, (l, t) => got.push([l, t]));
  s.push(Buffer.from("x".repeat(100_000)));
  s.push(Buffer.from("y".repeat(50_000)));
  s.push(Buffer.from("zzz" + String.fromCharCode(10) + "next" + String.fromCharCode(10)));
  s.end();
  assert.deepEqual(got, [
    ["x".repeat(10), true],
    ["next", false],
  ]);
});

test("lineSplitter: a complete over-limit line is clipped", () => {
  const got: Array<[string, boolean]> = [];
  const s = lineSplitter(10, (l, t) => got.push([l, t]));
  const nl = String.fromCharCode(10);
  s.push(Buffer.from("a".repeat(50) + nl + "ok" + nl));
  s.end();
  assert.deepEqual(got, [
    ["a".repeat(10), true],
    ["ok", false],
  ]);
});

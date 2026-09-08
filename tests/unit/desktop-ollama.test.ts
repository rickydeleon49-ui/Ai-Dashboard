/**
 * The desktop shell's Ollama supervisor.
 *
 * Process launching is exactly the part that must not be tested by launching
 * processes, so `spawn` and `fetch` are injected. What is being pinned down
 * here is the ownership contract: never start a second server, and never stop
 * one this application did not start.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createOllamaSupervisor, candidates } = require("../../desktop/ollama.js") as {
  createOllamaSupervisor: (options: Record<string, unknown>) => {
    probe: () => Promise<boolean>;
    ensureRunning: (options?: { timeoutMs?: number }) => Promise<{
      state: string;
      owned: boolean;
      error: string | null;
    }>;
    stopIfOwned: () => boolean;
    isOwned: () => boolean;
  };
  candidates: (platform: string, env: Record<string, string>) => string[];
};

/** A child process that never really existed. */
class FakeChild extends EventEmitter {
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
}

interface Harness {
  healthy: boolean;
  spawned: string[];
  children: FakeChild[];
}

/**
 * @param behaviour what each candidate does: "start" makes the API healthy,
 *                  "enoent" fails the way a missing executable does, and
 *                  "silent" starts but never answers.
 */
function harness(behaviour: (command: string) => "start" | "enoent" | "silent", healthy = false) {
  const state: Harness = { healthy, spawned: [], children: [] };

  const supervisor = createOllamaSupervisor({
    endpoint: "http://127.0.0.1:11434",
    platform: "linux",
    env: {},
    fetchImpl: async () =>
      state.healthy ? new Response("{}", { status: 200 }) : Promise.reject(new Error("ECONNREFUSED")),
    spawnImpl: (command: string) => {
      state.spawned.push(command);
      const child = new FakeChild();
      state.children.push(child);

      const outcome = behaviour(command);
      if (outcome === "start") state.healthy = true;
      // ENOENT is emitted asynchronously by the real spawn, which is precisely
      // why a plain try/catch around it would report success.
      if (outcome === "enoent") {
        setImmediate(() => child.emit("error", new Error("spawn ollama ENOENT")));
      }
      return child;
    },
  });

  return { supervisor, state };
}

describe("candidate locations", () => {
  it("looks in the Windows install directory as well as on PATH", () => {
    const found = candidates("win32", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" });
    assert.ok(found.includes("ollama.exe"));
    assert.ok(found.some((entry) => entry.includes("Programs")));
  });

  it("looks in the usual unix locations", () => {
    assert.deepEqual(candidates("linux", {})[0], "ollama");
    assert.ok(candidates("darwin", {}).some((entry) => entry.includes("homebrew")));
  });
});

describe("starting Ollama", () => {
  it("adopts an instance that is already running without spawning anything", async () => {
    const { supervisor, state } = harness(() => "start", true);

    const result = await supervisor.ensureRunning();

    assert.equal(result.state, "running");
    assert.equal(result.owned, false);
    assert.deepEqual(state.spawned, []);
    assert.equal(supervisor.isOwned(), false);
  });

  it("starts one when nothing is listening, and owns it", async () => {
    const { supervisor, state } = harness(() => "start");

    const result = await supervisor.ensureRunning({ timeoutMs: 500 });

    assert.equal(result.state, "started");
    assert.equal(result.owned, true);
    assert.deepEqual(state.spawned, ["ollama"]);
    assert.equal(supervisor.isOwned(), true);
  });

  it("moves on to the next location when the executable is not there", async () => {
    const { supervisor, state } = harness((command) =>
      command === "ollama" ? "enoent" : "start",
    );

    const result = await supervisor.ensureRunning({ timeoutMs: 500 });

    assert.equal(result.state, "started");
    assert.equal(state.spawned.length, 2);
    assert.equal(state.spawned[0], "ollama");
  });

  it("reports failure when Ollama is not installed anywhere it looks", async () => {
    const { supervisor, state } = harness(() => "enoent");

    const result = await supervisor.ensureRunning({ timeoutMs: 200 });

    assert.equal(result.state, "failed");
    assert.equal(result.owned, false);
    assert.match(String(result.error), /ENOENT/);
    assert.ok(state.spawned.length >= 1);
    assert.equal(supervisor.isOwned(), false);
  });

  it("gives up on a process that starts but never answers", async () => {
    const { supervisor, state } = harness(() => "silent");

    const result = await supervisor.ensureRunning({ timeoutMs: 150 });

    assert.equal(result.state, "failed");
    // Every candidate it tried was killed rather than left running.
    assert.ok(state.children.every((child) => child.killed));
  });

  it("adopts an instance that appeared while its own launch was failing", async () => {
    const state = { healthy: false, spawned: [] as string[] };
    const supervisor = createOllamaSupervisor({
      endpoint: "http://127.0.0.1:11434",
      platform: "linux",
      env: {},
      fetchImpl: async () =>
        state.healthy
          ? new Response("{}", { status: 200 })
          : Promise.reject(new Error("ECONNREFUSED")),
      spawnImpl: (command: string) => {
        state.spawned.push(command);
        const child = new FakeChild();
        setImmediate(() => {
          // The port was taken by something else starting at the same time.
          state.healthy = true;
          child.emit("exit", 1);
        });
        return child;
      },
    });

    const result = await supervisor.ensureRunning({ timeoutMs: 500 });

    assert.equal(result.state, "adopted");
    assert.equal(result.owned, false);
    assert.equal(supervisor.isOwned(), false);
  });
});

describe("stopping Ollama", () => {
  it("stops an instance it started", async () => {
    const { supervisor, state } = harness(() => "start");
    await supervisor.ensureRunning({ timeoutMs: 500 });

    assert.equal(supervisor.stopIfOwned(), true);
    assert.equal(state.children[0]?.killed, true);
  });

  it("leaves an instance it merely adopted alone", async () => {
    const { supervisor, state } = harness(() => "start", true);
    await supervisor.ensureRunning();

    assert.equal(supervisor.stopIfOwned(), false);
    assert.deepEqual(state.children, []);
  });

  it("is safe to call twice", async () => {
    const { supervisor } = harness(() => "start");
    await supervisor.ensureRunning({ timeoutMs: 500 });

    assert.equal(supervisor.stopIfOwned(), true);
    assert.equal(supervisor.stopIfOwned(), false);
  });
});

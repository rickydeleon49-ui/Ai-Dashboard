import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { launchFirst } = require("../../desktop/launch.js");

function fakeSpawn(outcomes: Array<"spawn" | "error">) {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const spawn = (command: string, args: string[], options: Record<string, unknown>) => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    calls.push({ command, args, options });
    const outcome = outcomes[calls.length - 1] ?? "error";
    queueMicrotask(() =>
      outcome === "spawn" ? child.emit("spawn") : child.emit("error", new Error("ENOENT")),
    );
    return child;
  };
  return { spawn, calls };
}

describe("desktop launcher", () => {
  it("returns the first application that actually starts", async () => {
    const fake = fakeSpawn(["error", "spawn"]);
    const result = await launchFirst(["missing", { command: "available", args: ["--flag"] }], "/tmp/project", fake.spawn);
    assert.equal(result, "available");
    assert.deepEqual(fake.calls.map((call) => call.command), ["missing", "available"]);
    assert.deepEqual(fake.calls[1]?.args, ["--flag"]);
  });

  it("returns null after every candidate fails", async () => {
    const fake = fakeSpawn(["error", "error"]);
    assert.equal(await launchFirst(["one", "two"], "/tmp/project", fake.spawn), null);
    assert.equal(fake.calls.length, 2);
  });

  it("never enables a shell and preserves path-like arguments as data", async () => {
    const fake = fakeSpawn(["spawn"]);
    const dangerous = "C:\\work & calc";
    await launchFirst([{ command: "Code.exe", args: [dangerous] }], dangerous, fake.spawn);
    assert.equal(fake.calls[0]?.options.shell, false);
    assert.deepEqual(fake.calls[0]?.args, [dangerous]);
    assert.equal(fake.calls[0]?.options.cwd, dangerous);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { probeContainerEngine } from "../../src/core/agents/container/engine";
import type { resolveExecutable } from "../../src/core/agents/resolve-executable";

type ExecCall = {
  file: string;
  args: string[];
  opts?: { timeout?: number };
};

function makeFakeResolve(
  map: Record<string, { file: string; prefixArgs?: string[] } | null>,
): typeof resolveExecutable {
  return ((command: string) => {
    const entry = map[command];
    if (!entry) {
      return { ok: false, tried: [`/fake/path/${command}`] };
    }
    return {
      ok: true,
      file: entry.file,
      prefixArgs: entry.prefixArgs ?? [],
      source: entry.file,
    };
  }) as typeof resolveExecutable;
}

test("docker ready: returns ready with resolved docker and trimmed version", async () => {
  const resolve = makeFakeResolve({
    docker: { file: "/usr/bin/docker", prefixArgs: [] },
    podman: null,
  });
  const execCalls: ExecCall[] = [];
  const execFile = async (file: string, args: string[], opts?: { timeout?: number }) => {
    execCalls.push({ file, args, opts });
    return { stdout: "27.0.3\n" };
  };

  const result = await probeContainerEngine({ resolve, execFile });

  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.deepEqual(result.engine, {
      kind: "docker",
      file: "/usr/bin/docker",
      prefixArgs: [],
      version: "27.0.3",
    });
  }
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0]?.file, "/usr/bin/docker");
  assert.deepEqual(execCalls[0]?.args, ["version", "--format", "{{.Server.Version}}"]);
  assert.equal(execCalls[0]?.opts?.timeout, 15000);
});

test("docker missing + podman ready: falls back to podman and returns ready", async () => {
  const resolve = makeFakeResolve({
    docker: null,
    podman: { file: "/usr/bin/podman", prefixArgs: [] },
  });
  const execCalls: ExecCall[] = [];
  const execFile = async (file: string, args: string[], opts?: { timeout?: number }) => {
    execCalls.push({ file, args, opts });
    return { stdout: "  5.0.0-rc2 \n" };
  };

  const result = await probeContainerEngine({ resolve, execFile });

  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.deepEqual(result.engine, {
      kind: "podman",
      file: "/usr/bin/podman",
      prefixArgs: [],
      version: "5.0.0-rc2",
    });
  }
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0]?.file, "/usr/bin/podman");
  assert.deepEqual(execCalls[0]?.args, ["version", "--format", "{{.Server.Version}}"]);
});

test("docker installed but daemon down -> not-running (and podman not tried only if podman missing)", async () => {
  const resolve = makeFakeResolve({
    docker: { file: "/usr/bin/docker", prefixArgs: [] },
    podman: null, // podman missing
  });
  const execCalls: ExecCall[] = [];
  const execFile = async (file: string, args: string[], opts?: { timeout?: number }) => {
    execCalls.push({ file, args, opts });
    throw new Error(
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\nSecond line with env PATH=/bin",
    );
  };

  const result = await probeContainerEngine({ resolve, execFile });

  assert.equal(result.status, "not-running");
  if (result.status === "not-running") {
    assert.equal(result.kind, "docker");
    assert.equal(
      result.detail,
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    );
  }
  // docker was tried, but podman was missing so podman execFile was not tried
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0]?.file, "/usr/bin/docker");
});

test("docker installed but daemon down + podman ready: returns ready with podman", async () => {
  const resolve = makeFakeResolve({
    docker: { file: "/usr/bin/docker", prefixArgs: [] },
    podman: { file: "/usr/bin/podman", prefixArgs: [] },
  });
  const execCalls: ExecCall[] = [];
  const execFile = async (file: string, args: string[], opts?: { timeout?: number }) => {
    execCalls.push({ file, args, opts });
    if (file === "/usr/bin/docker") {
      throw new Error("Cannot connect to the Docker daemon");
    }
    return { stdout: "5.0.1" };
  };

  const result = await probeContainerEngine({ resolve, execFile });

  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.deepEqual(result.engine, {
      kind: "podman",
      file: "/usr/bin/podman",
      prefixArgs: [],
      version: "5.0.1",
    });
  }
  assert.equal(execCalls.length, 2);
  assert.equal(execCalls[0]?.file, "/usr/bin/docker");
  assert.equal(execCalls[1]?.file, "/usr/bin/podman");
});

test("prefer podman: probes podman first and returns ready without trying docker", async () => {
  const resolve = makeFakeResolve({
    docker: { file: "/usr/bin/docker", prefixArgs: [] },
    podman: { file: "/usr/bin/podman", prefixArgs: [] },
  });
  const execCalls: ExecCall[] = [];
  const execFile = async (file: string, args: string[], opts?: { timeout?: number }) => {
    execCalls.push({ file, args, opts });
    return { stdout: "5.1.0\n" };
  };

  const result = await probeContainerEngine({
    resolve,
    execFile,
    prefer: "podman",
  });

  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.deepEqual(result.engine, {
      kind: "podman",
      file: "/usr/bin/podman",
      prefixArgs: [],
      version: "5.1.0",
    });
  }
  // docker was never called because podman was preferred and ready
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0]?.file, "/usr/bin/podman");
});

test("neither installed: returns not-installed without executing any commands", async () => {
  const resolve = makeFakeResolve({
    docker: null,
    podman: null,
  });
  const execCalls: ExecCall[] = [];
  const execFile = async (file: string, args: string[], opts?: { timeout?: number }) => {
    execCalls.push({ file, args, opts });
    return { stdout: "1.0.0" };
  };

  const result = await probeContainerEngine({ resolve, execFile });

  assert.deepEqual(result, { status: "not-installed" });
  assert.equal(execCalls.length, 0);
});

test("detail truncated to 200 chars: first line longer than 200 chars is capped", async () => {
  const longErrorLine = "A".repeat(350);
  const resolve = makeFakeResolve({
    docker: { file: "/usr/bin/docker", prefixArgs: [] },
    podman: null,
  });
  const execFile = async () => {
    throw new Error(`${longErrorLine}\nSecond line with full env: PATH=/usr/bin`);
  };

  const result = await probeContainerEngine({ resolve, execFile });

  assert.equal(result.status, "not-running");
  if (result.status === "not-running") {
    assert.equal(result.kind, "docker");
    assert.equal(result.detail.length, 200);
    assert.equal(result.detail, "A".repeat(200));
    assert.ok(!result.detail.includes("Second line"));
    assert.ok(!result.detail.includes("PATH"));
  }
});

test("args never contain a shell string: execFile receives argument array without shell concatenation", async () => {
  const resolve = makeFakeResolve({
    docker: { file: "C:\\Program Files\\Docker\\docker.exe", prefixArgs: [] },
    podman: null,
  });
  let capturedFile = "";
  let capturedArgs: string[] = [];
  let capturedOpts: { timeout?: number } | undefined;

  const execFile = async (file: string, args: string[], opts?: { timeout?: number }) => {
    capturedFile = file;
    capturedArgs = args;
    capturedOpts = opts;
    return { stdout: "26.1.1" };
  };

  await probeContainerEngine({ resolve, execFile });

  assert.equal(capturedFile, "C:\\Program Files\\Docker\\docker.exe");
  assert.ok(Array.isArray(capturedArgs), "args must be an array");
  assert.deepEqual(capturedArgs, ["version", "--format", "{{.Server.Version}}"]);

  for (const arg of capturedArgs) {
    assert.ok(!arg.includes("docker version"), "arg must not contain a full command line");
    assert.ok(!arg.includes(";"), "arg must not contain shell delimiter ;");
    assert.ok(!arg.includes("&&"), "arg must not contain shell operator &&");
    assert.ok(!arg.includes("|"), "arg must not contain shell pipe |");
  }

  assert.equal(capturedOpts?.timeout, 15000);
});

test("prefixArgs are preserved when running version check and in ready engine", async () => {
  const resolve = makeFakeResolve({
    docker: { file: "node.exe", prefixArgs: ["C:\\Tools\\docker-entry.js"] },
    podman: null,
  });
  let passedArgs: string[] = [];
  const execFile = async (_file: string, args: string[]) => {
    passedArgs = args;
    return { stdout: "25.0.0" };
  };

  const result = await probeContainerEngine({ resolve, execFile });

  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.deepEqual(result.engine.prefixArgs, ["C:\\Tools\\docker-entry.js"]);
    assert.equal(result.engine.version, "25.0.0");
  }
  assert.deepEqual(passedArgs, [
    "C:\\Tools\\docker-entry.js",
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
});

test("rejects .cmd and .bat shims and tries next engine", async () => {
  const resolve = makeFakeResolve({
    docker: { file: "C:\\Tools\\docker.cmd", prefixArgs: [] },
    podman: { file: "C:\\Tools\\podman.exe", prefixArgs: [] },
  });
  const execCalls: ExecCall[] = [];
  const execFile = async (file: string, args: string[], opts?: { timeout?: number }) => {
    execCalls.push({ file, args, opts });
    return { stdout: "5.0.0" };
  };

  const result = await probeContainerEngine({ resolve, execFile });

  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.equal(result.engine.kind, "podman");
    assert.equal(result.engine.file, "C:\\Tools\\podman.exe");
  }
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0]?.file, "C:\\Tools\\podman.exe");
});

test("empty stdout -> not-running with short detail", async () => {
  const resolve = makeFakeResolve({
    docker: { file: "/usr/bin/docker", prefixArgs: [] },
    podman: null,
  });
  const execFile = async () => ({ stdout: "   \n  " });

  const result = await probeContainerEngine({ resolve, execFile });

  assert.equal(result.status, "not-running");
  if (result.status === "not-running") {
    assert.equal(result.kind, "docker");
    assert.ok(result.detail.length > 0);
    assert.ok(result.detail.length <= 200);
  }
});

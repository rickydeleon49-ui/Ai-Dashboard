import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { listShells, shellEnv, createSessionManager, loadPty } = require("../../desktop/pty-sessions.js");

type Manager = ReturnType<typeof createSessionManager>;

const isWin = process.platform === "win32";
const shellId = isWin ? "cmd" : "login";
const tempDirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "trm-pty-"));
  tempDirs.push(dir);
  return dir;
}

function waitFor(check: () => boolean, ms = 15000) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > ms) {
        clearInterval(timer);
        reject(new Error("timed out"));
      }
    }, 50);
  });
}

function realManager(extra: Record<string, unknown> = {}) {
  const output = new Map<string, string>();
  const exits = new Map<string, number>();
  const manager: Manager = createSessionManager({
    pty: loadPty(),
    shells: listShells(),
    env: shellEnv(process.env),
    onData: (id: string, data: string) => output.set(id, (output.get(id) ?? "") + data),
    onExit: (id: string, code: number) => exits.set(id, code),
    ...extra,
  });
  return { manager, output, exits };
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("desktop pty sessions (real node-pty)", () => {
  it("runs a command, reports exit after kill and drops the count", async () => {
    const { manager, output, exits } = realManager();
    const dir = tempDir();
    const created = manager.create({ shellId, cwd: dir, cols: 100, rows: 30 });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.cwd, dir);
    assert.ok(created.title.endsWith(path.basename(dir)));
    assert.equal(manager.count(), 1);

    manager.write(created.id, "echo trm-ok\r");
    // The echoed command line also contains the marker, so wait for it twice
    // (command echo plus command output).
    await waitFor(() => ((output.get(created.id) ?? "").match(/trm-ok/g) ?? []).length >= 2);
    manager.resize(created.id, 120, 40);

    manager.kill(created.id);
    await waitFor(() => exits.has(created.id));
    assert.equal(manager.count(), 0);
    manager.kill(created.id);
  });

  it("killAll leaves nothing running and is safe twice", async () => {
    const { manager, exits } = realManager();
    const a = manager.create({ shellId, cwd: tempDir() });
    const b = manager.create({ shellId, cwd: null });
    assert.ok(a.ok && b.ok);
    assert.equal(manager.count(), 2);
    manager.killAll();
    manager.killAll();
    await waitFor(() => exits.size === 2);
    assert.equal(manager.count(), 0);
  });

  it("refuses bad input without throwing", async () => {
    const { manager } = realManager({ maxSessions: 2 });
    const dir = tempDir();
    const missing = path.join(dir, "nope");
    const cases = [
      { shellId: "fish-from-the-renderer", cwd: dir },
      { shellId, cwd: "relative/path" },
      { shellId, cwd: missing },
      { shellId, cwd: dir, cols: 0 },
      { shellId, cwd: dir, cols: 501 },
      { shellId, cwd: dir, rows: 0 },
      { shellId, cwd: dir, cols: 80.5 },
    ];
    for (const request of cases) {
      const result = manager.create(request);
      assert.equal(result.ok, false, JSON.stringify(request));
    }
    assert.equal(manager.count(), 0);

    const first = manager.create({ shellId, cwd: dir });
    const second = manager.create({ shellId, cwd: dir });
    assert.ok(first.ok && second.ok);
    const third = manager.create({ shellId, cwd: dir });
    assert.equal(third.ok, false);
    if (!third.ok) assert.match(third.error, /maximum 2/);

    if (first.ok) {
      manager.write(first.id, 42 as unknown as string);
      manager.write(first.id, "x".repeat(64 * 1024 + 1));
      manager.write("no-such-id", "echo hi\r");
      assert.equal(manager.launch(first.id, "rm"), false);
      assert.equal(manager.launch(first.id, "claude; rm -rf /"), false);
    }
    manager.killAll();
    await waitFor(() => manager.count() === 0);
  });

  it("refuses a ninth session with the default limit", () => {
    const spawned: string[] = [];
    const fakePty = {
      spawn: (file: string) => {
        spawned.push(file);
        return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
      },
    };
    const manager = createSessionManager({
      pty: fakePty,
      shells: [{ id: "x", label: "X", file: "x", args: [] }],
      env: {},
    });
    const dir = tempDir();
    for (let i = 0; i < 8; i += 1) assert.equal(manager.create({ shellId: "x", cwd: dir }).ok, true);
    const ninth = manager.create({ shellId: "x", cwd: dir });
    assert.equal(ninth.ok, false);
    assert.equal(spawned.length, 8);
  });

  it("launch types exactly the tool name plus a carriage return", () => {
    const writes: string[] = [];
    const fakePty = {
      spawn: () => ({ onData() {}, onExit() {}, write: (d: string) => writes.push(d), resize() {}, kill() {} }),
    };
    const manager = createSessionManager({
      pty: fakePty,
      shells: [{ id: "x", label: "X", file: "x", args: [] }],
      env: {},
    });
    const created = manager.create({ shellId: "x", cwd: tempDir() });
    assert.ok(created.ok);
    if (!created.ok) return;
    for (const tool of ["claude", "agy", "codex"]) assert.equal(manager.launch(created.id, tool), true);
    assert.deepEqual(writes, ["claude\r", "agy\r", "codex\r"]);
    assert.equal(manager.launch(created.id, "rm"), false);
    assert.equal(writes.length, 3);
  });
});

describe("shellEnv", () => {
  it("strips app internals, keeps the user's own variables", () => {
    const result = shellEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      USERPROFILE: "C:\\Users\\u",
      GITHUB_TOKEN: "ghp_user",
      ELECTRON_RUN_AS_NODE: "1",
      DESKTOP_INTERNAL_SECRET: "s",
      DESKTOP_TEST_MODE: "1",
      NEXT_RUNTIME: "nodejs",
      npm_config_cache: "x",
      NODE_OPTIONS: "--inspect",
      NODE_ENV: "production",
      DATABASE_URL: "postgres://x",
      DATABASE_PATH: "/db",
      UPLOADS_DIR: "/up",
      SETTINGS_ENCRYPTION_KEY: "k",
      DASHBOARD_LOCAL: "1",
      PORT: "1234",
      HOSTNAME: "127.0.0.1",
      TERM: "dumb",
    });
    for (const key of [
      "ELECTRON_RUN_AS_NODE",
      "DESKTOP_INTERNAL_SECRET",
      "DESKTOP_TEST_MODE",
      "NEXT_RUNTIME",
      "npm_config_cache",
      "NODE_OPTIONS",
      "NODE_ENV",
      "DATABASE_URL",
      "DATABASE_PATH",
      "UPLOADS_DIR",
      "SETTINGS_ENCRYPTION_KEY",
      "DASHBOARD_LOCAL",
      "PORT",
      "HOSTNAME",
    ]) {
      assert.equal(key in result, false, key);
    }
    assert.equal(result.PATH, "/usr/bin");
    assert.equal(result.HOME, "/home/u");
    assert.equal(result.USERPROFILE, "C:\\Users\\u");
    assert.equal(result.GITHUB_TOKEN, "ghp_user");
    assert.equal(result.TERM, "xterm-256color");
    assert.equal(result.COLORTERM, "truecolor");
  });
});

describe("listShells", () => {
  it("lists Windows shells, with Git Bash only when it exists", () => {
    const env = { ProgramFiles: "C:\\Program Files", PATH: "C:\\tools;C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
    const without = listShells({ platform: "win32", env, exists: () => false });
    assert.deepEqual(without.map((s: { id: string }) => s.id), ["powershell", "cmd"]);
    assert.match(without[0].file, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);

    const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
    const pwsh = "C:\\tools\\pwsh.exe";
    const withAll = listShells({ platform: "win32", env, exists: (p: string) => p === bash || p === pwsh });
    assert.deepEqual(withAll.map((s: { id: string }) => s.id), ["powershell", "git-bash", "cmd"]);
    assert.equal(withAll[0].file, pwsh);
    assert.deepEqual(withAll[1].args, ["--login", "-i"]);

    const nextToGit = listShells({
      platform: "win32",
      env: { PATH: "D:\\Git\\cmd" },
      exists: (p: string) => p === "D:\\Git\\cmd\\git.exe" || p === "D:\\Git\\bin\\bash.exe",
    });
    assert.ok(nextToGit.some((s: { id: string }) => s.id === "git-bash"));
  });

  it("lists login shell plus zsh and bash on darwin", () => {
    const shells = listShells({
      platform: "darwin",
      env: { SHELL: "/opt/homebrew/bin/fish", PATH: "/usr/bin" },
      exists: (p: string) => p === "/bin/zsh" || p === "/bin/bash",
    });
    assert.deepEqual(shells.map((s: { id: string }) => s.id), ["login", "zsh", "bash"]);
    assert.equal(shells[0].file, "/opt/homebrew/bin/fish");
    assert.deepEqual(shells[0].args, ["-l"]);

    const fallback = listShells({ platform: "darwin", env: {}, exists: () => false });
    assert.deepEqual(fallback.map((s: { id: string }) => s.id), ["login"]);
    assert.equal(fallback[0].file, "/bin/zsh");
    assert.equal(listShells({ platform: "linux", env: {}, exists: () => false })[0].file, "/bin/bash");
  });
});

describe("terminal vendor copy", () => {
  it("copies node-pty, its win32-x64 prebuild and xterm into a folder", async () => {
    const vendorModule = "../../desktop/vendor.mjs"; // untyped build script
    const { copyTerminalVendor } = await import(vendorModule);
    const dest = path.join(tempDir(), "vendor");
    const root = process.cwd();
    await copyTerminalVendor(root, dest, { platform: "win32", arch: "x64" });
    assert.ok(existsSync(path.join(dest, "node-pty", "package.json")));
    assert.ok(existsSync(path.join(dest, "node-pty", "lib", "index.js")));
    assert.ok(existsSync(path.join(dest, "node-pty", "prebuilds", "win32-x64", "conpty.node")));
    assert.equal(existsSync(path.join(dest, "node-pty", "src")), false);
    assert.ok(existsSync(path.join(dest, "xterm", "xterm.js")));
    assert.ok(existsSync(path.join(dest, "xterm", "xterm.css")));
    assert.ok(existsSync(path.join(dest, "xterm", "addon-fit.js")));
    // No prebuild and no local build (an empty root): refused, nothing half-copied.
    await assert.rejects(
      copyTerminalVendor(tempDir(), path.join(dest, "x"), { platform: "win32", arch: "ia32" }),
      /no prebuild or local build/,
    );
    assert.equal(existsSync(path.join(dest, "x")), false);
  });
});

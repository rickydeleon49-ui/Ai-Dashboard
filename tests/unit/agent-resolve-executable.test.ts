import assert from "node:assert/strict";
import test from "node:test";
import {
  entryFromCmdShim,
  isSafeAbsolute,
  resolveExecutable,
} from "../../src/core/agents/resolve-executable";

const SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`;

function fakeFs(files: Record<string, string>) {
  const norm = (p: string) => p.toLowerCase();
  const map = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  return {
    fileExists: (p: string) => map.has(norm(p)),
    readFile: (p: string) => map.get(norm(p)) ?? null,
  };
}

const winEnv = {
  PATH: "C:\\Tools;C:\\Other",
  APPDATA: "C:\\Users\\me\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  USERPROFILE: "C:\\Users\\me",
};

test("windows: native .exe on PATH is returned directly", () => {
  const r = resolveExecutable("claude", {
    platform: "win32",
    env: winEnv,
    ...fakeFs({ "C:\\Other\\claude.exe": "" }),
  });
  assert.deepEqual(r, {
    ok: true,
    file: "C:\\Other\\claude.exe",
    prefixArgs: [],
    source: "C:\\Other\\claude.exe",
  });
});

test("windows: .cmd shim resolves to node.exe plus the package entry, never the .cmd", () => {
  const dir = "C:\\Users\\me\\AppData\\Roaming\\npm";
  const entry = `${dir}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
  const r = resolveExecutable("claude", {
    platform: "win32",
    env: winEnv,
    nodeExecPath: "C:\\fallback\\node.exe",
    ...fakeFs({ [`${dir}\\claude.cmd`]: SHIM, [entry]: "", [`${dir}\\node.exe`]: "" }),
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.file, `${dir}\\node.exe`);
  assert.deepEqual(r.prefixArgs, [entry]);
  assert.ok(!/\.(cmd|bat)$/i.test(r.file));
});

test("windows: shim without a neighbouring node.exe falls back to node on PATH, then execPath", () => {
  const dir = "C:\\Users\\me\\AppData\\Roaming\\npm";
  const entry = `${dir}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
  const base = { [`${dir}\\claude.cmd`]: SHIM, [entry]: "" };
  const onPath = resolveExecutable("claude", {
    platform: "win32",
    env: winEnv,
    nodeExecPath: "C:\\fallback\\node.exe",
    ...fakeFs({ ...base, "C:\\Tools\\node.exe": "" }),
  });
  assert.ok(onPath.ok && onPath.file === "C:\\Tools\\node.exe");
  const fallback = resolveExecutable("claude", {
    platform: "win32",
    env: winEnv,
    nodeExecPath: "C:\\fallback\\node.exe",
    ...fakeFs(base),
  });
  assert.ok(fallback.ok && fallback.file === "C:\\fallback\\node.exe");
});

test("windows: a shim whose entry is missing or unparseable is skipped, not returned", () => {
  const dir = "C:\\Users\\me\\AppData\\Roaming\\npm";
  const r = resolveExecutable("claude", {
    platform: "win32",
    env: winEnv,
    ...fakeFs({ [`${dir}\\claude.cmd`]: SHIM }),
  });
  assert.equal(r.ok, false);
  const garbage = resolveExecutable("claude", {
    platform: "win32",
    env: winEnv,
    ...fakeFs({ [`${dir}\\claude.cmd`]: "echo hi" }),
  });
  assert.equal(garbage.ok, false);
});

test("not found lists every path tried", () => {
  const r = resolveExecutable("claude", { platform: "win32", env: winEnv, ...fakeFs({}) });
  assert.equal(r.ok, false);
  if (r.ok) return;
  for (const expected of [
    "C:\\Tools\\claude.exe",
    "C:\\Tools\\claude.cmd",
    "C:\\Other\\claude.exe",
    "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
    "C:\\Users\\me\\AppData\\Local\\Programs\\claude.exe",
    "C:\\Users\\me\\.local\\bin\\claude.exe",
  ]) {
    assert.ok(r.tried.includes(expected), `missing ${expected}`);
  }
  assert.equal(new Set(r.tried).size, r.tried.length);
});

test("explicit path wins over PATH, and a bad explicit path is reported not replaced", () => {
  const files = fakeFs({ "C:\\Tools\\claude.exe": "", "D:\\mine\\claude.exe": "" });
  const win = resolveExecutable("claude", {
    platform: "win32",
    env: winEnv,
    explicitPath: "D:\\mine\\claude.exe",
    ...files,
  });
  assert.ok(win.ok && win.file === "D:\\mine\\claude.exe");
  const bad = resolveExecutable("claude", {
    platform: "win32",
    env: winEnv,
    explicitPath: "D:\\nope\\claude.exe",
    ...files,
  });
  assert.deepEqual(bad, { ok: false, tried: ["D:\\nope\\claude.exe"] });
});

test("explicit .cmd path is resolved through its shim", () => {
  const dir = "E:\\npm";
  const entry = `${dir}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
  const r = resolveExecutable("claude", {
    platform: "win32",
    env: winEnv,
    explicitPath: `${dir}\\claude.cmd`,
    ...fakeFs({ [`${dir}\\claude.cmd`]: SHIM, [entry]: "", [`${dir}\\node.exe`]: "" }),
  });
  assert.ok(r.ok && r.file === `${dir}\\node.exe` && r.prefixArgs[0] === entry);
});

test("posix: finds a binary on PATH and in known install locations", () => {
  const env = { PATH: "/usr/bin:/bin", HOME: "/home/me" };
  const onPath = resolveExecutable("claude", {
    platform: "linux",
    env,
    ...fakeFs({ "/usr/bin/claude": "" }),
  });
  assert.ok(onPath.ok && onPath.file === "/usr/bin/claude" && onPath.prefixArgs.length === 0);
  const brew = resolveExecutable("claude", {
    platform: "darwin",
    env,
    ...fakeFs({ "/opt/homebrew/bin/claude": "" }),
  });
  assert.ok(brew.ok && brew.file === "/opt/homebrew/bin/claude");
  const local = resolveExecutable("claude", {
    platform: "linux",
    env,
    ...fakeFs({ "/home/me/.local/bin/claude": "" }),
  });
  assert.ok(local.ok && local.file === "/home/me/.local/bin/claude");
  const none = resolveExecutable("claude", { platform: "linux", env, ...fakeFs({}) });
  assert.ok(!none.ok && none.tried.includes("/home/me/.local/bin/claude"));
});

test("entryFromCmdShim ignores the node.exe probe line", () => {
  assert.equal(
    entryFromCmdShim(SHIM),
    "node_modules\\@anthropic-ai\\claude-code\\cli.js",
  );
});

const B = String.fromCharCode(92);
const w = (...parts: string[]) => parts.join(B);

test("relative PATH entries are ignored (a planted binary in cwd cannot win)", () => {
  const safe = w("C:", "Safe", "claude.exe");
  const files = fakeFs({
    [w(".", "claude.exe")]: "",
    [w("bin", "claude.exe")]: "",
    [safe]: "",
    [B + B + w("server", "share", "claude.exe")]: "",
  });
  const unc = B + B + w("server", "share");
  const device = B + B + "?" + B + w("C:", "x");
  const r = resolveExecutable("claude", {
    platform: "win32",
    env: { PATH: [".", "bin", unc, device, w("C:", "Safe")].join(";") },
    ...files,
  });
  assert.ok(r.ok && r.file === safe);
  const none = resolveExecutable("claude", { platform: "win32", env: { PATH: ".;bin" }, ...files });
  assert.ok(!none.ok);
  assert.ok(
    !none.ok &&
      !none.tried.some((t) => t.startsWith(".") || t.startsWith("bin") || t.startsWith(B + B)),
  );
  const posix = resolveExecutable("claude", {
    platform: "linux",
    env: { PATH: ".:bin:/safe" },
    ...fakeFs({ "./claude": "", "bin/claude": "", "/safe/claude": "" }),
  });
  assert.ok(posix.ok && posix.file === "/safe/claude");
});

test("a relative or UNC explicit path is refused", () => {
  const unc = B + B + w("srv", "s", "claude.exe");
  const rel = w(".", "claude.exe");
  const files = fakeFs({ "claude.exe": "", [rel]: "", [unc]: "" });
  for (const explicitPath of ["claude.exe", rel, unc]) {
    assert.deepEqual(
      resolveExecutable("claude", { platform: "win32", env: winEnv, explicitPath, ...files }),
      { ok: false, tried: [explicitPath] },
    );
  }
  assert.deepEqual(
    resolveExecutable("claude", {
      platform: "linux",
      env: {},
      explicitPath: "bin/claude",
      ...fakeFs({ "bin/claude": "" }),
    }),
    { ok: false, tried: ["bin/claude"] },
  );
});

test("windows: drive-relative and rooted-without-drive paths are rejected", () => {
  const rooted = B + w("bin", "claude.exe");
  const driveRel = "C:" + w("bin", "claude.exe");
  const files = fakeFs({ [rooted]: "", [driveRel]: "" });
  for (const explicitPath of [rooted, driveRel]) {
    assert.deepEqual(
      resolveExecutable("claude", { platform: "win32", env: winEnv, explicitPath, ...files }),
      { ok: false, tried: [explicitPath] },
    );
  }
  const viaPath = resolveExecutable("claude", {
    platform: "win32",
    env: { PATH: B + "bin" },
    ...files,
  });
  assert.ok(!viaPath.ok && !viaPath.tried.some((t) => t.startsWith(B + "bin")));
  assert.ok(isSafeAbsolute("C:/tools", "win32"));
});

test("windows: a command that already has an extension is not suffixed again", () => {
  const dir = "C:" + B + "Tools";
  const exe = resolveExecutable("claude.EXE", {
    platform: "win32",
    env: { PATH: dir },
    ...fakeFs({ [w(dir, "claude.EXE")]: "" }),
  });
  assert.ok(exe.ok && exe.file === w(dir, "claude.EXE"));
  const npmDir = w("C:", "n");
  const entry = w(npmDir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  const cmd = resolveExecutable("claude.cmd", {
    platform: "win32",
    env: { PATH: npmDir },
    nodeExecPath: "N",
    ...fakeFs({ [w(npmDir, "claude.cmd")]: SHIM, [entry]: "" }),
  });
  assert.ok(cmd.ok && cmd.prefixArgs[0] === entry);
  const miss = resolveExecutable("claude.exe", { platform: "win32", env: { PATH: dir }, ...fakeFs({}) });
  assert.ok(!miss.ok && !miss.tried.some((t) => /exe.(exe|cmd)$/i.test(t)));
});

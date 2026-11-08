/**
 * Terminal sessions for the desktop app (main process only).
 *
 * Owns every interactive shell the terminal window opens. The renderer never
 * names a program or an argument: it picks a shell id from the fixed list in
 * `listShells`, and `launch` only ever types one of three known tool names.
 */
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

/**
 * @typedef {{ id: string, label: string, file: string, args: string[] }} ShellSpec
 * @typedef {{ ok: true, id: string, title: string, cwd: string } | { ok: false, error: string }} CreateResult
 */

const MAX_WRITE_BYTES = 64 * 1024;
const LAUNCH_TOOLS = new Set(["claude", "agy", "codex"]);

/**
 * Loads node-pty. The packaged app ships a trimmed copy in ./vendor/node-pty
 * (see build.mjs); a checkout falls back to the installed dependency.
 */
function loadPty() {
  const vendored = path.join(__dirname, "vendor", "node-pty");
  if (fs.existsSync(vendored)) return require(vendored);
  return require("node-pty");
}

/** @param {string} p */
function defaultExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Finds an executable on PATH.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} env
 * @param {(p: string) => boolean} exists
 * @param {string} sep
 * @param {(...p: string[]) => string} join
 */
function onPath(name, env, exists, sep, join) {
  const pathVar = env.PATH ?? env.Path ?? env.path ?? "";
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * The fixed list of shells a terminal can open.
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv, exists?: (p: string) => boolean }} [options]
 * @returns {ShellSpec[]}
 */
function listShells({ platform = process.platform, env = process.env, exists = defaultExists } = {}) {
  /** @type {ShellSpec[]} */
  const shells = [];

  if (platform === "win32") {
    const join = path.win32.join;
    const pwsh = onPath("pwsh.exe", env, exists, ";", join);
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
    shells.push({
      id: "powershell",
      label: "PowerShell",
      file: pwsh ?? join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: ["-NoLogo"],
    });

    /** @type {string[]} */
    const gitRoots = [];
    const programFiles = env.ProgramFiles ?? env.PROGRAMFILES;
    if (programFiles) gitRoots.push(join(programFiles, "Git"));
    const gitExe = onPath("git.exe", env, exists, ";", join);
    if (gitExe) gitRoots.push(path.win32.dirname(path.win32.dirname(gitExe)));
    for (const gitRoot of gitRoots) {
      const bash = join(gitRoot, "bin", "bash.exe");
      if (exists(bash)) {
        shells.push({ id: "git-bash", label: "Git Bash", file: bash, args: ["--login", "-i"] });
        break;
      }
    }

    shells.push({
      id: "cmd",
      label: "Command Prompt",
      file: env.ComSpec ?? env.COMSPEC ?? join(systemRoot, "System32", "cmd.exe"),
      args: [],
    });
    return shells;
  }

  const fallback = platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  const loginShell = env.SHELL && path.posix.isAbsolute(env.SHELL) ? env.SHELL : fallback;
  shells.push({ id: "login", label: "Login shell", file: loginShell, args: ["-l"] });
  for (const name of ["zsh", "bash"]) {
    const candidate = onPath(name, env, exists, ":", path.posix.join) ?? `/bin/${name}`;
    if (exists(candidate)) shells.push({ id: name, label: name, file: candidate, args: ["-l"] });
  }
  return shells;
}

/**
 * Environment for a user's shell: the app's own process environment minus what
 * only the app's children should see.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Record<string, string>}
 */
function shellEnv(env) {
  /** Exact names main.js sets for its server and runner children. */
  const internalNames = new Set([
    "NODE_OPTIONS",
    "NODE_ENV",
    "DATABASE_URL",
    "DATABASE_PATH",
    "UPLOADS_DIR",
    "SETTINGS_ENCRYPTION_KEY",
    "DASHBOARD_LOCAL",
    "PORT",
    "HOSTNAME",
  ]);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    // Electron's own switches (ELECTRON_RUN_AS_NODE would turn a user's `node` into the app).
    if (key.startsWith("ELECTRON_")) continue;
    // Desktop shell internals, including DESKTOP_INTERNAL_SECRET and test switches.
    if (key.startsWith("DESKTOP_")) continue;
    // Next.js server settings meant for the bundled server only.
    if (key.startsWith("NEXT_")) continue;
    // npm run-script context leaks into unrelated tools.
    if (key.startsWith("npm_")) continue;
    // Named app internals: runtime mode, database location, the settings
    // encryption key and the local-server switches main.js sets for children.
    // The user's own tokens (GITHUB_TOKEN etc.) are deliberately kept.
    if (internalNames.has(key)) continue;
    out[key] = value;
  }
  // Terminal capabilities xterm.js actually provides.
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  return out;
}

/** @param {unknown} n @param {number} min @param {number} max */
function intInRange(n, min, max) {
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
}

/**
 * @param {{
 *   pty: { spawn: Function },
 *   shells: ShellSpec[],
 *   env?: Record<string, string>,
 *   maxSessions?: number,
 *   onData?: (id: string, data: string) => void,
 *   onExit?: (id: string, exitCode: number) => void,
 * }} options
 */
function createSessionManager({ pty, shells, env = {}, maxSessions = 8, onData, onExit }) {
  /** @type {Map<string, any>} */
  const sessions = new Map();

  /** @param {{ shellId: string, cwd?: string | null, cols?: number, rows?: number }} request @returns {CreateResult} */
  function create(request) {
    try {
      const { shellId, cwd, cols = 80, rows = 24 } = request ?? {};
      const shell = shells.find((s) => s.id === shellId);
      if (!shell) return { ok: false, error: "Unknown shell." };
      if (!intInRange(cols, 2, 500)) return { ok: false, error: "Columns must be a whole number from 2 to 500." };
      if (!intInRange(rows, 1, 300)) return { ok: false, error: "Rows must be a whole number from 1 to 300." };

      let dir = cwd;
      if (dir === null || dir === undefined) {
        dir = os.homedir();
      } else if (typeof dir !== "string" || !path.isAbsolute(dir)) {
        return { ok: false, error: "The folder must be an absolute path." };
      }
      let isDir = false;
      try {
        isDir = fs.statSync(dir).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) return { ok: false, error: "That folder does not exist." };

      if (sessions.size >= maxSessions) {
        return { ok: false, error: `Too many terminals open (maximum ${maxSessions}). Close one first.` };
      }

      const id = crypto.randomUUID();
      const proc = pty.spawn(shell.file, shell.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: dir,
        env,
      });
      sessions.set(id, proc);
      proc.onData((data) => {
        if (sessions.get(id) === proc) onData?.(id, data);
      });
      proc.onExit(({ exitCode }) => {
        if (sessions.get(id) === proc) sessions.delete(id);
        onExit?.(id, exitCode);
      });
      const folder = path.basename(dir) || dir;
      return { ok: true, id, title: `${shell.label} - ${folder}`, cwd: dir };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Could not start the shell." };
    }
  }

  /** @param {string} id @param {unknown} data */
  function write(id, data) {
    const proc = sessions.get(id);
    if (!proc || typeof data !== "string" || Buffer.byteLength(data) > MAX_WRITE_BYTES) return;
    try {
      proc.write(data);
    } catch {
      /* shell already gone */
    }
  }

  /** @param {string} id @param {unknown} cols @param {unknown} rows */
  function resize(id, cols, rows) {
    const proc = sessions.get(id);
    if (!proc || !intInRange(cols, 2, 500) || !intInRange(rows, 1, 300)) return;
    try {
      proc.resize(cols, rows);
    } catch {
      /* shell already gone */
    }
  }

  /** @param {string} id */
  function kill(id) {
    const proc = sessions.get(id);
    if (!proc) return;
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  }

  /** @param {string} id @param {unknown} tool */
  function launch(id, tool) {
    if (typeof tool !== "string" || !LAUNCH_TOOLS.has(tool)) return false;
    if (!sessions.has(id)) return false;
    write(id, `${tool}\r`);
    return true;
  }

  function killAll() {
    for (const id of [...sessions.keys()]) kill(id);
  }

  return { create, write, resize, kill, launch, killAll, count: () => sessions.size };
}

module.exports = { listShells, shellEnv, createSessionManager, loadPty };

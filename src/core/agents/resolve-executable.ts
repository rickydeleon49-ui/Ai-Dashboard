/**
 * Resolve a command name (`claude`, `codex`, `npm`) to something that can be
 * spawned with `shell: false`.
 *
 * Why this exists (design §5A): on Windows npm installs `.cmd` shims, which
 * Node refuses to spawn without a shell, and a shell would bring command-line
 * injection back. So a shim is read, the package's real entry point is found
 * from it, and the result is `node.exe` + that entry (or a native `.exe`).
 * The returned `file` is never a `.cmd` or `.bat`.
 *
 * The search never relies on one shell's PATH: it uses the inherited PATH plus
 * the known install locations, and reports every path it tried.
 *
 * Pure-ish: the file system, environment and platform are injected, so the
 * Windows logic is testable on any OS.
 */
import fs from "node:fs";
import nodePath from "node:path";

export type ResolveResult =
  | { ok: true; file: string; prefixArgs: string[]; source: string }
  | { ok: false; tried: string[] };

export interface ResolveDeps {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  homedir?: string;
  /** True for an existing regular file. */
  fileExists?: (p: string) => boolean;
  readFile?: (p: string) => string | null;
  /** Fallback node binary when none sits beside a shim or on PATH. */
  nodeExecPath?: string;
}

export interface ResolveOptions extends ResolveDeps {
  /** A path the user configured. When set it is the only candidate. */
  explicitPath?: string | null;
  /** Extra directories to search after PATH and the known locations. */
  extraDirs?: string[];
}

const defaultFileExists = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

const defaultReadFile = (p: string): string | null => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

function envGet(
  env: Record<string, string | undefined>,
  name: string,
  win: boolean,
): string | undefined {
  if (!win) return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

/**
 * Absolute. On Windows this means a drive-letter root (`C:\` or `C:/`), which
 * also rejects UNC and device paths, drive-relative `\bin` and `C:bin`.
 */
export function isSafeAbsolute(p: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    const sep = (c: string | undefined) => c === "/" || c === String.fromCharCode(92);
    return /^[A-Za-z]$/.test(p[0] ?? "") && p[1] === ":" && sep(p[2]);
  }
  return nodePath.posix.isAbsolute(p);
}

/** The directories to search, in order, without duplicates. */
export function searchDirs(deps: ResolveDeps = {}, extraDirs: string[] = []): string[] {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const win = platform === "win32";
  const p = win ? nodePath.win32 : nodePath.posix;
  const home = deps.homedir ?? (win ? envGet(env, "USERPROFILE", true) : env.HOME) ?? "";
  const dirs: string[] = [];

  const pathVar = envGet(env, "PATH", win) ?? "";
  dirs.push(
    ...pathVar
      .split(win ? ";" : ":")
      .map((d) => d.replace(/^"|"$/g, ""))
      .filter(Boolean),
  );

  if (win) {
    const appData = envGet(env, "APPDATA", true);
    const local = envGet(env, "LOCALAPPDATA", true);
    const programFiles = envGet(env, "ProgramFiles", true);
    if (appData) dirs.push(p.join(appData, "npm"));
    if (local) dirs.push(p.join(local, "Programs"));
    if (home) dirs.push(p.join(home, ".local", "bin"));
    if (programFiles) dirs.push(p.join(programFiles, "nodejs"));
    const volta = envGet(env, "VOLTA_HOME", true) ?? (local ? p.join(local, "Volta") : undefined);
    if (volta) dirs.push(p.join(volta, "bin"));
  } else {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin");
    if (home) {
      dirs.push(
        p.join(home, ".local", "bin"),
        p.join(home, ".volta", "bin"),
        p.join(home, ".npm-global", "bin"),
      );
    }
  }
  dirs.push(...extraDirs);
  // Relative entries (".", "bin") would let a planted binary in the current
  // directory win, and UNC/device paths are never install locations.
  return [...new Set(dirs.filter((d) => isSafeAbsolute(d, platform)))];
}

/**
 * Extract the package entry point from an npm `.cmd` shim. npm writes lines like
 *   "%_prog%"  "%dp0%\node_modules\@scope\pkg\cli.js" %*
 * (and, for packages shipping a native binary, a `.exe` in the same position).
 */
export function entryFromCmdShim(content: string): string | null {
  const re = /"%(?:~?dp0)%?\\([^"]+)"/gi;
  let match: RegExpExecArray | null;
  let found: string | null = null;
  while ((match = re.exec(content)) !== null) {
    const rel = match[1];
    if (rel && !/^node\.exe$/i.test(rel) && /\.(?:c|m)?js$|\.exe$/i.test(rel)) found = rel;
  }
  if (found) return found;
  // Older shims use %~dp0\ directly.
  const old = /%~dp0\\([^"\s]+\.(?:(?:c|m)?js|exe))/i.exec(content);
  return old?.[1] ?? null;
}

export function resolveExecutable(command: string, options: ResolveOptions = {}): ResolveResult {
  const platform = options.platform ?? process.platform;
  const win = platform === "win32";
  const p = win ? nodePath.win32 : nodePath.posix;
  const fileExists = options.fileExists ?? defaultFileExists;
  const readFile = options.readFile ?? defaultReadFile;
  const nodeExecPath = options.nodeExecPath ?? process.execPath;
  const tried: string[] = [];
  const dirs = searchDirs(options, options.extraDirs);

  const findNode = (shimDir: string): string => {
    const beside = p.join(shimDir, "node.exe");
    if (fileExists(beside)) return beside;
    for (const dir of dirs) {
      const candidate = p.join(dir, "node.exe");
      if (fileExists(candidate)) return candidate;
    }
    return nodeExecPath;
  };

  /** Turn one concrete existing file into a spawnable form, or null. */
  const accept = (candidate: string): ResolveResult | null => {
    tried.push(candidate);
    if (!fileExists(candidate)) return null;
    if (!win) return { ok: true, file: candidate, prefixArgs: [], source: candidate };
    const ext = p.extname(candidate).toLowerCase();
    if (ext === ".exe" || ext === ".com") {
      return { ok: true, file: candidate, prefixArgs: [], source: candidate };
    }
    if (ext === ".cmd" || ext === ".bat") {
      const content = readFile(candidate);
      const rel = content ? entryFromCmdShim(content) : null;
      if (!rel) return null; // Unparseable shim: never hand it back as the file.
      const entry = p.join(p.dirname(candidate), rel);
      if (!fileExists(entry)) {
        tried.push(entry);
        return null;
      }
      if (p.extname(entry).toLowerCase() === ".exe") {
        return { ok: true, file: entry, prefixArgs: [], source: candidate };
      }
      return { ok: true, file: findNode(p.dirname(candidate)), prefixArgs: [entry], source: candidate };
    }
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      return { ok: true, file: findNode(p.dirname(candidate)), prefixArgs: [candidate], source: candidate };
    }
    return null;
  };

  if (options.explicitPath) {
    if (!isSafeAbsolute(options.explicitPath, platform)) {
      return { ok: false, tried: [options.explicitPath] };
    }
    const hit = accept(options.explicitPath);
    if (hit) return hit;
    // A configured path that does not work is reported, not silently replaced.
    return { ok: false, tried };
  }

  // A command that already names an extension is searched for as given.
  const hasExt = /\.(?:exe|cmd|bat)$/i.test(command);
  const names = win && !hasExt ? [`${command}.exe`, `${command}.cmd`] : [command];
  for (const dir of dirs) {
    for (const name of names) {
      const hit = accept(p.join(dir, name));
      if (hit) return hit;
    }
  }
  return { ok: false, tried };
}

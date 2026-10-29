/**
 * The only place an agent child process is spawned (design §2.3, §5A, §7).
 *
 * `shell` is always false and `windowsHide` always true. On POSIX the child is
 * `detached`, which makes it a process-group leader so Stop can signal the
 * whole group. On Windows there are no groups: Stop uses `taskkill /T`, which
 * walks the process tree. taskkill is spawned from its absolute path with
 * `shell: false` too.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { createNdjsonParser } from "../ai/ndjson";

export interface AgentExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when a stop() call was in flight when the process ended. */
  stoppedByUs: boolean;
  /** Set when the process could not be started or errored. */
  error?: string;
}

export interface SpawnAgentOptions {
  file: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Text to write to stdin, then close. Omit to close stdin immediately. */
  stdin?: string;
  onJson?: (value: unknown) => void;
  /** Non-JSON stdout lines and stderr lines. Bounded. */
  onText?: (stream: "stdout" | "stderr", text: string) => void;
  /** Max characters kept per text line (default 4000). */
  maxLineChars?: number;
  /** Max total text characters delivered via onText (default 1,000,000). */
  maxTextChars?: number;
  platform?: NodeJS.Platform;
}

export interface AgentProcessHandle {
  readonly pid: number | undefined;
  /** POSIX process group id (equals pid for a detached child). */
  readonly pgid: number | undefined;
  readonly platform: NodeJS.Platform;
  readonly child: ChildProcess;
  /** Resolves once the process has exited and its output has drained. */
  done: Promise<AgentExit>;
  /** Set by stopAgentProcess(). */
  stopRequested: boolean;
  exited: boolean;
}

const DRAIN_WAIT_MS = 500;

interface LineSplitter {
  push(chunk: Buffer): void;
  end(): void;
}

/**
 * Splits a byte stream into lines. A line longer than `maxLine` (complete or
 * not) is delivered once, clipped to its head with `truncated = true`; the rest
 * of that line is dropped up to the next newline, never emitted as fragments.
 */
export function lineSplitter(
  maxLine: number,
  onLine: (line: string, truncated: boolean) => void,
): LineSplitter {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let overflow = false;
  const emit = (raw: string) => {
    const line = raw.replace(/\r$/, "");
    if (line.length > maxLine) onLine(line.slice(0, maxLine), true);
    else onLine(line, false);
  };
  const feed = (input: string) => {
    let text = input;
    while (text.length > 0) {
      const i = text.indexOf("\n");
      if (overflow) {
        if (i === -1) return; // still inside the dropped remainder
        text = text.slice(i + 1);
        overflow = false;
        continue;
      }
      if (i === -1) {
        buffer += text;
        if (buffer.length > maxLine) {
          onLine(buffer.slice(0, maxLine), true);
          buffer = "";
          overflow = true;
        }
        return;
      }
      buffer += text.slice(0, i);
      text = text.slice(i + 1);
      emit(buffer);
      buffer = "";
    }
  };
  return {
    push: (chunk) => feed(decoder.write(chunk)),
    end: () => {
      feed(decoder.end());
      if (!overflow && buffer) emit(buffer);
      buffer = "";
    },
  };
}

export function spawnAgentProcess(options: SpawnAgentOptions): AgentProcessHandle {
  const platform = options.platform ?? process.platform;
  const win = platform === "win32";
  const maxLine = options.maxLineChars ?? 4000;
  let textBudget = options.maxTextChars ?? 1_000_000;
  let truncatedNoted = false;

  const emitText = (stream: "stdout" | "stderr", text: string) => {
    if (!options.onText || text === "") return;
    if (textBudget <= 0) {
      if (!truncatedNoted) {
        truncatedNoted = true;
        options.onText(stream, "[output truncated]");
      }
      return;
    }
    const clipped = text.length > maxLine ? text.slice(0, maxLine) : text;
    textBudget -= clipped.length;
    options.onText(stream, clipped);
  };

  const child = spawn(options.file, options.args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    detached: !win,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const handle: AgentProcessHandle = {
    pid: child.pid,
    pgid: win ? undefined : child.pid,
    platform,
    child,
    stopRequested: false,
    exited: false,
    done: undefined as unknown as Promise<AgentExit>,
  };

  // JSON events can be large; allow far longer lines than plain text.
  const stdout = lineSplitter(maxLine * 250, (line, truncated) => {
    if (!line.trim()) return;
    if (!truncated) {
      try {
        // A fresh parser per complete line: one malformed line must not wedge
        // the stream (the shared parser keeps a bad line in its buffer).
        const values = createNdjsonParser().push(line + "\n");
        // Zero values (e.g. a lone "{") is not JSON we understood: never drop it.
        if (values.length === 0) {
          emitText("stdout", line);
          return;
        }
        for (const value of values) {
          if (value !== null && typeof value === "object") options.onJson?.(value);
          else emitText("stdout", line);
        }
        return;
      } catch {
        // Not JSON: fall through to text.
      }
    }
    emitText("stdout", line);
  });
  const stderr = lineSplitter(maxLine, (line) => emitText("stderr", line));
  child.stdout?.on("data", (c: Buffer) => stdout.push(c));
  child.stderr?.on("data", (c: Buffer) => stderr.push(c));
  child.stdin?.on("error", () => {});
  if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  else child.stdin?.end();

  handle.done = new Promise<AgentExit>((resolve) => {
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let errorText: string | undefined;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      stdout.end();
      stderr.end();
      handle.exited = true;
      resolve({
        code: exitInfo?.code ?? null,
        signal: exitInfo?.signal ?? null,
        stoppedByUs: handle.stopRequested,
        ...(errorText ? { error: errorText } : {}),
      });
    };
    child.once("error", (err) => {
      errorText = err.message;
      if (!exitInfo) exitInfo = { code: null, signal: null };
      settle();
    });
    child.once("exit", (code, signal) => {
      exitInfo = { code, signal };
      handle.exited = true;
      // A surviving grandchild can hold the pipes open; do not wait forever.
      setTimeout(settle, DRAIN_WAIT_MS).unref();
    });
    child.once("close", settle);
  });

  return handle;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function taskkillPath(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? "C:\\Windows";
  return path.win32.join(root, "System32", "taskkill.exe");
}

function runTaskkill(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
    try {
      const k = spawn(taskkillPath(process.env), args, {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      k.once("error", () => resolve());
      k.once("close", () => resolve());
    } catch {
      resolve();
    }
  });
}

function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH (already gone) or EPERM: nothing more to do.
  }
}

/**
 * Ask the process (and everything it started) to stop, force it after
 * `graceMs`, and resolve with how it exited. Never throws; a no-op on a
 * process that has already exited.
 */
export async function stopAgentProcess(
  handle: AgentProcessHandle,
  options: {
    graceMs?: number;
    /** Test seam: replaces taskkill / process-group signalling. */
    killer?: (pid: number, force: boolean) => Promise<void>;
  } = {},
): Promise<AgentExit> {
  const graceMs = options.graceMs ?? 5000;
  if (handle.pid === undefined) return handle.done;
  const pid = handle.pid;
  const win = handle.platform === "win32";

  // POSIX: is anything still in the process group? (signal 0 sends nothing.)
  const groupAlive = (): boolean => {
    if (options.killer) return true; // test seam cannot be probed
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };

  // The leader has exited already. On Windows taskkill /T cannot walk a tree
  // whose root is gone (known limitation; a Job Object is the later fix), and
  // signalling a dead pid risks hitting a recycled one, so do nothing. On POSIX
  // the group may still hold descendants, so carry on only if it does.
  if (handle.exited && (win || !groupAlive())) return handle.done;

  handle.stopRequested = true;

  try {
    const kill = async (force: boolean) => {
      if (options.killer) await options.killer(pid, force);
      else if (win) await runTaskkill(pid, force);
      else killGroup(pid, force ? "SIGKILL" : "SIGTERM");
    };
    await kill(false);

    if (win) {
      await Promise.race([handle.done, sleep(graceMs)]);
      // Always force, even if the parent exited during the grace period: the
      // tree link may be gone and /T may find nothing, so this is best-effort.
      await kill(true);
    } else {
      // Wait for the leader to exit and the group to empty, up to the grace.
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline && !(handle.exited && !groupAlive())) {
        await sleep(25);
      }
      // Only force when something is still there, right before signalling, to
      // narrow the PID-reuse window.
      if (groupAlive()) await kill(true);
    }
  } catch {
    // Never throw from stop.
  }
  // Bounded: a failed forced kill must not leave the caller waiting forever.
  const result = await Promise.race([
    handle.done,
    sleep(graceMs).then((): AgentExit => ({
      code: null,
      signal: null,
      stoppedByUs: true,
      error: "process did not exit after stop",
    })),
  ]);
  return result;
}

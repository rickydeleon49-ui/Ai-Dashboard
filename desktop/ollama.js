/**
 * Ollama lifecycle for the desktop shell.
 *
 * Kept out of `main.js` and free of any Electron import so it can be exercised
 * as plain Node with a fake `spawn` and a fake `fetch`. Process launching is
 * exactly the part that must not be tested by launching processes.
 *
 * The rules it exists to enforce:
 *
 *   Never start a second server. The port is checked first, and a healthy
 *   instance is adopted rather than duplicated.
 *
 *   Never kill something we did not start. If Ollama was already running —
 *   the tray app, a terminal, another tool — closing Command Center leaves it
 *   exactly as it found it. Ownership is tracked explicitly for that reason.
 *
 *   Never build a command line. Candidates are argv arrays with `shell: false`,
 *   so a path containing a space or a semicolon is an argument and never
 *   syntax. Nothing here is user-supplied in any case: the candidate list is
 *   fixed in this file.
 */
const path = require("node:path");

/** Where Ollama is normally found, per platform. Tried in order. */
function candidates(platform, env) {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    return [
      "ollama.exe",
      ...(local ? [path.join(local, "Programs", "Ollama", "ollama.exe")] : []),
      ...(env.ProgramFiles ? [path.join(env.ProgramFiles, "Ollama", "ollama.exe")] : []),
    ];
  }
  if (platform === "darwin") {
    return [
      "ollama",
      "/usr/local/bin/ollama",
      "/opt/homebrew/bin/ollama",
      "/Applications/Ollama.app/Contents/Resources/ollama",
    ];
  }
  return ["ollama", "/usr/local/bin/ollama", "/usr/bin/ollama", "/bin/ollama"];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {string} options.endpoint      Ollama base URL, e.g. http://127.0.0.1:11434
 * @param {Function} [options.fetchImpl] Injected for tests.
 * @param {Function} [options.spawnImpl] Injected for tests.
 * @param {string} [options.platform]
 * @param {object} [options.env]
 * @param {Function} [options.logger]    Receives one structured object per event.
 */
function createOllamaSupervisor(options) {
  const endpoint = String(options.endpoint || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const spawnImpl = options.spawnImpl || require("node:child_process").spawn;
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const log = options.logger || (() => {});

  /** The child we started, if we started one. Null means we own nothing. */
  let child = null;

  /**
   * Whether the API answers.
   *
   * `/api/tags` rather than a bare TCP connect: something else could hold the
   * port, and "the port is open" is not "Ollama is ready to answer".
   */
  async function probe(timeoutMs = 1500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${endpoint}/api/tags`, {
        signal: controller.signal,
      });
      return Boolean(response && response.ok);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Polls until the API answers or the deadline passes. */
  async function waitForHealthy(timeoutMs, intervalMs = 400) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await probe()) return true;
      if (Date.now() >= deadline) return false;
      await sleep(intervalMs);
    }
  }

  /**
   * Starts one candidate.
   *
   * ENOENT from `spawn` arrives as an asynchronous 'error' event, not as a
   * throw, so a plain try/catch would report a missing executable as a
   * successful launch and then wait out the whole health timeout. This waits
   * for whichever comes first: the error, an early exit, or a healthy API.
   */
  async function launch(command, timeoutMs) {
    let handle;
    try {
      handle = spawnImpl(command, ["serve"], {
        stdio: "ignore",
        // Not detached: a server this process started should not outlive it if
        // the app is killed, and on Windows a detached child cannot be
        // reliably signalled afterwards.
        detached: false,
        windowsHide: true,
        env,
      });
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }

    let failure = null;
    handle.on("error", (error) => {
      failure = error && error.message ? error.message : String(error);
    });
    handle.on("exit", (code) => {
      if (failure === null) failure = `ollama exited with code ${code}`;
    });

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // Checked before health, not after: a child that has already died cannot
      // be the thing answering, and claiming to own a process that exited
      // would mean believing we had stopped Ollama on quit when we had not.
      if (failure !== null) return { ok: false, error: failure };
      if (await probe()) return { ok: true, handle };
      if (Date.now() >= deadline) {
        try {
          handle.kill();
        } catch {
          // Already gone.
        }
        return { ok: false, error: `Ollama did not answer within ${Math.round(timeoutMs / 1000)}s` };
      }
      await sleep(400);
    }
  }

  /**
   * Connects to Ollama, starting it only if nothing is already serving.
   *
   * Resolves to one of:
   *   { state: "running",  owned: false }  something was already there
   *   { state: "started",  owned: true  }  we launched it
   *   { state: "adopted",  owned: false }  our launch failed but it is healthy
   *                                        anyway — someone else won the race
   *   { state: "failed",   owned: false, error }
   */
  async function ensureRunning({ timeoutMs = 30_000 } = {}) {
    if (await probe()) {
      log({ event: "startup", ok: true, state: "running", owned: false });
      return { state: "running", owned: false, error: null };
    }

    const attempts = [];
    for (const command of candidates(platform, env)) {
      const result = await launch(command, timeoutMs);
      if (result.ok) {
        child = result.handle;
        log({ event: "startup", ok: true, state: "started", owned: true, command });
        return { state: "started", owned: true, error: null };
      }
      attempts.push(`${command}: ${result.error}`);

      // Two things can start Ollama at once — the tray app and us. If the port
      // is healthy now, the right answer is to use it, not to try harder.
      if (await probe()) {
        log({ event: "startup", ok: true, state: "adopted", owned: false });
        return { state: "adopted", owned: false, error: null };
      }
    }

    const error = attempts.join("; ");
    log({ event: "startup", ok: false, state: "failed", detail: error });
    return { state: "failed", owned: false, error };
  }

  /** Stops Ollama only if this process started it. */
  function stopIfOwned() {
    if (!child) return false;
    try {
      child.kill();
    } catch {
      // Already exited.
    }
    child = null;
    return true;
  }

  return {
    endpoint,
    probe,
    waitForHealthy,
    ensureRunning,
    stopIfOwned,
    isOwned: () => child !== null,
  };
}

module.exports = { createOllamaSupervisor, candidates };

import "server-only";

import fs from "node:fs";
import path from "node:path";
import { aiLog } from "./logging";
import {
  AiError,
  type AIProvider,
  type ChatEvent,
  type ChatRequest,
  type LocalModel,
  type ProviderStatus,
} from "./types";

/**
 * The seam Hermes Agent will arrive through.
 *
 * What this does today is detect whether Hermes is installed and report it.
 * What it deliberately does **not** do is execute anything — not even
 * `hermes --version`. The executable path is a user setting, settings are
 * writable through the HTTP API, and "run the binary named in a setting" turns
 * a settings write into arbitrary code execution. Detection by `stat` gives the
 * user the same answer with none of that.
 *
 * When agent support lands, `chat` is what changes. The workspace, the status
 * strip and the provider switch already speak this interface, so nothing above
 * this file has to move.
 */

/** Executable name per platform. No arguments, no shell, no interpolation. */
function executableNames(): string[] {
  return process.platform === "win32" ? ["hermes.exe", "hermes.cmd", "hermes"] : ["hermes"];
}

export interface HermesLocation {
  found: boolean;
  /** Absolute path, when found. */
  path: string | null;
  /** "setting" when it came from the configured path, "path" when from PATH. */
  origin: "setting" | "path" | null;
  /** Why a configured path was rejected, when it was. */
  problem: string | null;
}

/**
 * Finds Hermes without running it.
 *
 * A configured path must be absolute and must be a file: a relative path would
 * resolve against whatever directory the server happens to be started in, which
 * is not something the user can see or reason about.
 */
export function locateHermes(configuredPath: string): HermesLocation {
  const configured = configuredPath.trim();

  if (configured) {
    if (!path.isAbsolute(configured)) {
      return {
        found: false,
        path: null,
        origin: null,
        problem: "The Hermes path must be an absolute path to the executable.",
      };
    }
    try {
      if (fs.statSync(configured).isFile()) {
        return { found: true, path: configured, origin: "setting", problem: null };
      }
      return {
        found: false,
        path: null,
        origin: null,
        problem: "That path exists but is not a file.",
      };
    } catch {
      return {
        found: false,
        path: null,
        origin: null,
        problem: "Nothing exists at that path.",
      };
    }
  }

  // No configured path: look for the command on PATH the way a shell would,
  // by joining and testing, rather than by asking a shell to do it.
  const entries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of entries) {
    for (const name of executableNames()) {
      const candidate = path.join(directory, name);
      try {
        if (fs.statSync(candidate).isFile()) {
          return { found: true, path: candidate, origin: "path", problem: null };
        }
      } catch {
        // Not here; keep looking.
      }
    }
  }

  return { found: false, path: null, origin: null, problem: null };
}

export class HermesAgentProvider implements AIProvider {
  readonly id = "hermes" as const;
  readonly label = "Hermes Agent";

  private readonly configuredPath: string;

  constructor(configuredPath: string) {
    this.configuredPath = configuredPath;
  }

  async status(): Promise<ProviderStatus> {
    const location = locateHermes(this.configuredPath);
    aiLog("hermes.probe", { provider: this.id, ok: location.found });

    if (!location.found) {
      return {
        provider: this.id,
        state: "offline",
        detail: location.problem
          ? location.problem
          : "Hermes was not found on this machine. Set its path in Settings if it is installed elsewhere.",
        endpoint: null,
        error: location.problem,
      };
    }

    return {
      provider: this.id,
      state: "ready",
      detail:
        "Hermes is installed. Agent workflows are not connected yet — Chat mode is available now.",
      endpoint: location.path,
      error: null,
    };
  }

  /** Hermes runs models through Ollama, so it installs none of its own. */
  async listModels(): Promise<LocalModel[]> {
    return [];
  }

  /**
   * Refuses, on purpose.
   *
   * Answering an agent request by quietly forwarding it to the chat model would
   * produce something that reads like an agent and can do nothing — the exact
   * failure mode this boundary exists to prevent.
   */
  async *chat(_request: ChatRequest): AsyncGenerator<ChatEvent, void, void> {
    const error = new AiError(
      "unsupported",
      "Agent mode is not connected yet. Switch to Chat mode to use your local models.",
    );
    yield { type: "error", code: error.code, message: error.message };
  }
}

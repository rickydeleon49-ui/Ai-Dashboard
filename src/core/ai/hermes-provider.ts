import "server-only";

import fs from "node:fs";
import path from "node:path";
import { aiLog } from "./logging";
import {
  DEFAULT_APPROVAL_POLICIES,
  evaluateAction,
  type ApprovalDecision,
  type ApprovalPolicies,
} from "./approvals";
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
 * What this does today is detect whether Hermes is installed, evaluate whether
 * it would be *allowed* to act, and report both. What it deliberately does
 * **not** do is execute anything — not even `hermes --version`. The executable
 * path is a user setting, settings are writable through the HTTP API, and "run
 * the binary named in a setting" turns a settings write into arbitrary code
 * execution. Detection by `stat` gives the user the same answer with none of
 * that.
 *
 * Every request is evaluated against `approvals.ts` before anything else is
 * considered, and the policy's refusal wins. Launching Hermes is itself running
 * a command, so `run_command` is the action that gates it: setting that to
 * "Blocked" stops this provider at the door, whether or not Hermes is
 * installed and whether or not execution is connected. Putting the gate in
 * before the execution means the execution is written against a policy that
 * already exists, rather than a policy retrofitted around whatever the
 * execution turned out to do.
 */

/** Starting Hermes is running a command, so that is the action it is gated on. */
export const HERMES_LAUNCH_ACTION = "run_command" as const;

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
      if (fs.statSync(/*turbopackIgnore: true*/ configured).isFile()) {
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
      const candidate = path.join(/*turbopackIgnore: true*/ directory, name);
      try {
        if (fs.statSync(/*turbopackIgnore: true*/ candidate).isFile()) {
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
  private readonly policies: ApprovalPolicies;

  constructor(configuredPath: string, policies: ApprovalPolicies = DEFAULT_APPROVAL_POLICIES) {
    this.configuredPath = configuredPath;
    this.policies = policies;
  }

  /** What the approval policy says about one action, for this provider. */
  gate(action: Parameters<typeof evaluateAction>[0]): ApprovalDecision {
    return evaluateAction(action, this.policies);
  }

  async status(): Promise<ProviderStatus> {
    const launch = this.gate(HERMES_LAUNCH_ACTION);

    // Checked before the filesystem: whether Hermes is installed is not the
    // interesting fact when the policy has already refused to run anything.
    if (!launch.allowed) {
      aiLog("hermes.probe", { provider: this.id, ok: false, detail: "blocked by policy" });
      return {
        provider: this.id,
        state: "disabled",
        detail: `${launch.reason} Agent mode cannot start Hermes while it is blocked.`,
        endpoint: null,
        error: null,
      };
    }

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
      detail: launch.requiresApproval
        ? "Hermes is installed, and running it will ask for your approval each time. Agent workflows are not connected yet — Chat mode is available now."
        : "Hermes is installed. Agent workflows are not connected yet — Chat mode is available now.",
      endpoint: location.path,
      error: null,
    };
  }

  /** Hermes runs models through Ollama, so it installs none of its own. */
  async listModels(): Promise<LocalModel[]> {
    return [];
  }

  /**
   * Refuses, on purpose — and says which of the two reasons applies.
   *
   * The policy is consulted first and its refusal wins, so a blocked
   * `run_command` reads as a decision the user made rather than as a missing
   * feature. Only once the policy would allow it does the honest second answer
   * apply: execution is not connected. Answering an agent request by quietly
   * forwarding it to the chat model would produce something that reads like an
   * agent and can do nothing — the exact failure mode this boundary exists to
   * prevent.
   */
  async *chat(_request: ChatRequest): AsyncGenerator<ChatEvent, void, void> {
    const launch = this.gate(HERMES_LAUNCH_ACTION);

    if (!launch.allowed) {
      const error = new AiError("not_configured", launch.reason);
      aiLog("generation.error", {
        provider: this.id,
        code: error.code,
        detail: "blocked by approval policy",
      });
      yield { type: "error", code: error.code, message: error.message };
      return;
    }

    const error = new AiError(
      "unsupported",
      launch.requiresApproval
        ? "Agent mode is not connected yet, so there is nothing to approve. Switch to Chat mode to use your local models."
        : "Agent mode is not connected yet. Switch to Chat mode to use your local models.",
    );
    yield { type: "error", code: error.code, message: error.message };
  }
}

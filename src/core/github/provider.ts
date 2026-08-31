import "server-only";

import { getSetting, SETTING_KEYS } from "@/core/settings/service";
import { DemoGitHubProvider } from "./demo-provider";
import { RestGitHubProvider } from "./rest-provider";
import type { GitHubProvider } from "./types";

/**
 * Where the active GitHub credential comes from.
 *
 * Reported to the user so the settings screen can explain which credential is in
 * play — otherwise a token saved in the app appears to do nothing when an
 * environment variable is quietly taking precedence, or vice versa.
 */
export type CredentialSource = "oauth" | "settings" | "environment" | "none";

export interface ResolvedProvider {
  provider: GitHubProvider;
  credentialSource: CredentialSource;
}

/**
 * Selects the active GitHub provider.
 *
 * Resolution order:
 *   1. A token saved in the application's own settings — from OAuth or pasted
 *   2. GITHUB_TOKEN from the environment — for servers and CI
 *   3. The demo provider — clearly-labelled sample data
 *
 * Settings win over the environment because they are the thing the user just
 * changed, in front of them, with a button. An environment variable set months
 * ago should not silently override it.
 *
 * Phase 2's OAuth flow stores its access token under the same settings key, so
 * nothing below this function changes when it lands.
 */
export function resolveGitHubProvider(): ResolvedProvider {
  const stored = getSetting(SETTING_KEYS.githubToken);
  if (stored) {
    // Same credential either way; only how it was obtained differs, and the
    // settings screen says so rather than leaving the user guessing.
    const origin = getSetting(SETTING_KEYS.githubTokenOrigin);
    const isOAuth = origin === "oauth";
    return {
      provider: new RestGitHubProvider(
        stored,
        isOAuth ? "a connected GitHub account" : "personal access token",
      ),
      credentialSource: isOAuth ? "oauth" : "settings",
    };
  }

  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) {
    return {
      provider: new RestGitHubProvider(
        fromEnv,
        "the GITHUB_TOKEN environment variable",
      ),
      credentialSource: "environment",
    };
  }

  return { provider: new DemoGitHubProvider(), credentialSource: "none" };
}

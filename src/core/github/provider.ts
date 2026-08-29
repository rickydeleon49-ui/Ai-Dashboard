import "server-only";

import { DemoGitHubProvider } from "./demo-provider";
import { RestGitHubProvider } from "./rest-provider";
import type { GitHubProvider } from "./types";

/**
 * Selects the active GitHub provider.
 *
 * Resolution order (each step is a later phase of the integration):
 *   1. OAuth access token stored for the signed-in user  — Phase 2, not yet wired
 *   2. GITHUB_TOKEN personal access token                — live data today
 *   3. Demo provider                                      — labelled sample data
 */
export function getGitHubProvider(): GitHubProvider {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) return new RestGitHubProvider(token);
  return new DemoGitHubProvider();
}

export function isGitHubConfigured(): boolean {
  return Boolean(process.env.GITHUB_TOKEN?.trim());
}

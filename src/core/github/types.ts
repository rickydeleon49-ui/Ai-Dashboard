/**
 * GitHub domain types.
 *
 * These mirror the shape the dashboard needs, not the raw API response, so that
 * swapping a PAT client for OAuth (Phase 2) changes nothing downstream.
 */

export interface GitHubRepository {
  /** GitHub's numeric repository id, stringified. */
  externalId: string;
  name: string;
  fullName: string;
  owner: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  openIssues: number;
  isPrivate: boolean;
  isArchived: boolean;
  isFork: boolean;
  defaultBranch: string;
  htmlUrl: string;
  homepage: string | null;
  topics: string[];
  pushedAt: string | null;
  updatedAt: string | null;
}

export interface GitHubAccount {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  htmlUrl: string;
}

/** How the dashboard is currently talking to GitHub. */
export type GitHubConnectionMode = "token" | "oauth" | "demo";

export interface GitHubConnection {
  connected: boolean;
  mode: GitHubConnectionMode;
  account: GitHubAccount | null;
  /** Human-readable explanation shown in the UI. */
  detail: string;
}

/**
 * The seam between the dashboard and GitHub.
 *
 * Phase 1 ships a token-backed implementation and a demo implementation.
 * Phase 2 adds an OAuth-backed one — implementing this same interface, so the
 * GitHub Hub UI does not change at all.
 */
export interface GitHubProvider {
  readonly mode: GitHubConnectionMode;
  getConnection(): Promise<GitHubConnection>;
  listRepositories(): Promise<GitHubRepository[]>;
}

/** Convenience link builders, used by the project detail actions. */
export const githubLinks = {
  repo: (htmlUrl: string) => htmlUrl,
  issues: (htmlUrl: string) => `${htmlUrl}/issues`,
  pulls: (htmlUrl: string) => `${htmlUrl}/pulls`,
  actions: (htmlUrl: string) => `${htmlUrl}/actions`,
  projects: (htmlUrl: string) => `${htmlUrl}/projects`,
  branches: (htmlUrl: string) => `${htmlUrl}/branches`,
  clone: (fullName: string) => `https://github.com/${fullName}.git`,
};

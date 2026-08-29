import "server-only";

import type {
  GitHubAccount,
  GitHubConnection,
  GitHubProvider,
  GitHubRepository,
} from "./types";

/** Minimal shape of the fields we read from the GitHub REST API. */
interface ApiRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  description: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  private: boolean;
  archived: boolean;
  fork: boolean;
  default_branch: string;
  html_url: string;
  homepage: string | null;
  topics?: string[];
  pushed_at: string | null;
  updated_at: string | null;
}

interface ApiUser {
  login: string;
  name: string | null;
  avatar_url: string | null;
  html_url: string;
}

const API = "https://api.github.com";

/**
 * Real GitHub client, authenticated with a bearer token.
 *
 * Works today with a Personal Access Token (GITHUB_TOKEN) and unchanged in
 * Phase 2 with an OAuth access token — the only difference is where the token
 * comes from, which is why it is a constructor argument.
 */
export class RestGitHubProvider implements GitHubProvider {
  readonly mode = "token" as const;

  constructor(private readonly token: string) {}

  private async request<T>(path: string): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ai-dashboard",
      },
      // Repository metadata is cached in our own database; always fetch fresh.
      cache: "no-store",
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `GitHub API ${response.status} on ${path}: ${body.slice(0, 200)}`,
      );
    }
    return (await response.json()) as T;
  }

  async getConnection(): Promise<GitHubConnection> {
    try {
      const user = await this.request<ApiUser>("/user");
      const account: GitHubAccount = {
        login: user.login,
        name: user.name,
        avatarUrl: user.avatar_url,
        htmlUrl: user.html_url,
      };
      return {
        connected: true,
        mode: "token",
        account,
        detail: `Authenticated as @${user.login} via personal access token.`,
      };
    } catch (error) {
      return {
        connected: false,
        mode: "token",
        account: null,
        detail:
          error instanceof Error
            ? `Token rejected by GitHub: ${error.message}`
            : "Token rejected by GitHub.",
      };
    }
  }

  async listRepositories(): Promise<GitHubRepository[]> {
    const collected: ApiRepo[] = [];
    // GitHub caps page size at 100; walk pages until a short page comes back.
    for (let page = 1; page <= 10; page += 1) {
      const batch = await this.request<ApiRepo[]>(
        `/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator,organization_member&sort=pushed`,
      );
      collected.push(...batch);
      if (batch.length < 100) break;
    }
    return collected.map(normalizeRepo);
  }
}

function normalizeRepo(repo: ApiRepo): GitHubRepository {
  return {
    externalId: String(repo.id),
    name: repo.name,
    fullName: repo.full_name,
    owner: repo.owner.login,
    description: repo.description,
    language: repo.language,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    openIssues: repo.open_issues_count,
    isPrivate: repo.private,
    isArchived: repo.archived,
    isFork: repo.fork,
    defaultBranch: repo.default_branch,
    htmlUrl: repo.html_url,
    homepage: repo.homepage,
    topics: repo.topics ?? [],
    pushedAt: repo.pushed_at,
    updatedAt: repo.updated_at,
  };
}

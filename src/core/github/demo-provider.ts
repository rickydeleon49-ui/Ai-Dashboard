import "server-only";

import type { GitHubConnection, GitHubProvider, GitHubRepository } from "./types";

/**
 * Stand-in provider used when no GitHub credentials are configured.
 *
 * This is NOT a fake of the real integration — it implements the same interface
 * and every screen labels it as demo data. Setting GITHUB_TOKEN switches the
 * whole app to live data with no UI changes.
 */
const DEMO_OWNER = "your-github-account";

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

const DEMO_REPOS: GitHubRepository[] = [
  {
    externalId: "demo-1",
    name: "Ai-Dashboard",
    fullName: `${DEMO_OWNER}/Ai-Dashboard`,
    owner: DEMO_OWNER,
    description:
      "Personal AI command center — projects, GitHub hub, uploads and AI workflows in one place.",
    language: "TypeScript",
    stars: 12,
    forks: 1,
    openIssues: 3,
    isPrivate: false,
    isArchived: false,
    isFork: false,
    defaultBranch: "main",
    htmlUrl: `https://github.com/${DEMO_OWNER}/Ai-Dashboard`,
    homepage: null,
    topics: ["dashboard", "nextjs", "ai"],
    pushedAt: daysAgo(0),
    updatedAt: daysAgo(0),
  },
  {
    externalId: "demo-2",
    name: "starfield-mod-tools",
    fullName: `${DEMO_OWNER}/starfield-mod-tools`,
    owner: DEMO_OWNER,
    description: "Utilities for authoring, packing and validating Starfield mods.",
    language: "Python",
    stars: 48,
    forks: 6,
    openIssues: 7,
    isPrivate: false,
    isArchived: false,
    isFork: false,
    defaultBranch: "main",
    htmlUrl: `https://github.com/${DEMO_OWNER}/starfield-mod-tools`,
    homepage: null,
    topics: ["starfield", "modding", "tooling"],
    pushedAt: daysAgo(4),
    updatedAt: daysAgo(4),
  },
  {
    externalId: "demo-3",
    name: "care-scheduling-app",
    fullName: `${DEMO_OWNER}/care-scheduling-app`,
    owner: DEMO_OWNER,
    description:
      "Shift and visit scheduling for care teams, with conflict detection and coverage reports.",
    language: "TypeScript",
    stars: 5,
    forks: 0,
    openIssues: 11,
    isPrivate: true,
    isArchived: false,
    isFork: false,
    defaultBranch: "main",
    htmlUrl: `https://github.com/${DEMO_OWNER}/care-scheduling-app`,
    homepage: null,
    topics: ["scheduling", "healthcare"],
    pushedAt: daysAgo(9),
    updatedAt: daysAgo(9),
  },
  {
    externalId: "demo-4",
    name: "ibkr-trading-agent",
    fullName: `${DEMO_OWNER}/ibkr-trading-agent`,
    owner: DEMO_OWNER,
    description:
      "Autonomous trading agent on ib_async with prompt caching for rate-limit-aware LLM calls.",
    language: "Python",
    stars: 31,
    forks: 4,
    openIssues: 2,
    isPrivate: true,
    isArchived: false,
    isFork: false,
    defaultBranch: "main",
    htmlUrl: `https://github.com/${DEMO_OWNER}/ibkr-trading-agent`,
    homepage: null,
    topics: ["trading", "agents", "anthropic"],
    pushedAt: daysAgo(2),
    updatedAt: daysAgo(2),
  },
  {
    externalId: "demo-5",
    name: "stock-watcher-pwa",
    fullName: `${DEMO_OWNER}/stock-watcher-pwa`,
    owner: DEMO_OWNER,
    description: "Installable price-watch PWA with push alerts, deployed on Railway.",
    language: "JavaScript",
    stars: 9,
    forks: 2,
    openIssues: 0,
    isPrivate: false,
    isArchived: false,
    isFork: false,
    defaultBranch: "main",
    htmlUrl: `https://github.com/${DEMO_OWNER}/stock-watcher-pwa`,
    homepage: "https://stock-watcher.up.railway.app",
    topics: ["pwa", "railway", "finance"],
    pushedAt: daysAgo(21),
    updatedAt: daysAgo(21),
  },
  {
    externalId: "demo-6",
    name: "pokemon-drop-monitor",
    fullName: `${DEMO_OWNER}/pokemon-drop-monitor`,
    owner: DEMO_OWNER,
    description:
      "Manifest V3 Chrome extension that queues Pokémon Center drops and autofills checkout.",
    language: "JavaScript",
    stars: 74,
    forks: 13,
    openIssues: 5,
    isPrivate: false,
    isArchived: false,
    isFork: false,
    defaultBranch: "main",
    htmlUrl: `https://github.com/${DEMO_OWNER}/pokemon-drop-monitor`,
    homepage: null,
    topics: ["chrome-extension", "manifest-v3", "automation"],
    pushedAt: daysAgo(38),
    updatedAt: daysAgo(38),
  },
];

export class DemoGitHubProvider implements GitHubProvider {
  readonly mode = "demo" as const;

  async getConnection(): Promise<GitHubConnection> {
    return {
      connected: false,
      mode: "demo",
      account: null,
      detail:
        "No GitHub credentials configured. Showing demo repositories so the hub is explorable.",
    };
  }

  async listRepositories(): Promise<GitHubRepository[]> {
    return DEMO_REPOS.map((repo) => ({ ...repo }));
  }
}

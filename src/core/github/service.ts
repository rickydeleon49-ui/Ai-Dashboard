import "server-only";

import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { activityEvents, githubRepositories } from "@/db/schema";
import type { GithubRepositoryRow } from "@/db/schema";
import { projectRepository } from "@/db/repositories";
import { createId } from "@/lib/ids";
import { resolveGitHubProvider, type CredentialSource } from "./provider";
import { DemoGitHubProvider } from "./demo-provider";
import type {
  GitHubConnection,
  GitHubProvider,
  GitHubRepository,
} from "./types";

export interface SyncResult {
  connection: GitHubConnection;
  fetched: number;
  created: number;
  updated: number;
  removed: number;
  syncedAt: string;
  /**
   * Whether stale rows were pruned. False when the sync ran unauthenticated, in
   * which case the cache was left alone — the UI says so rather than implying
   * the listed repositories are all that remain.
   */
  pruned: boolean;
}

/** A cached repository plus whether it is already on the dashboard. */
export interface HubRepository extends GitHubRepository {
  linkedProjectId: string | null;
  syncedAt: string;
}

function rowToHub(row: GithubRepositoryRow): HubRepository {
  let topics: string[] = [];
  try {
    topics = JSON.parse(row.topics) as string[];
  } catch {
    topics = [];
  }
  return {
    externalId: row.externalId,
    name: row.name,
    fullName: row.fullName,
    owner: row.owner,
    description: row.description,
    language: row.language,
    stars: row.stars,
    forks: row.forks,
    openIssues: row.openIssues,
    isPrivate: row.isPrivate,
    isArchived: row.isArchived,
    isFork: row.isFork,
    defaultBranch: row.defaultBranch,
    htmlUrl: row.htmlUrl,
    homepage: row.homepage,
    topics,
    pushedAt: row.pushedAt,
    updatedAt: row.updatedAt,
    linkedProjectId: row.linkedProjectId,
    syncedAt: row.syncedAt,
  };
}

/*
 * Connection probes hit the GitHub API, and three pages read the connection
 * while rendering — the hub, settings and integrations. Without a cache, simply
 * navigating between them spends network round-trips and rate limit on a value
 * that changes only when credentials change.
 *
 * Cached per process with a short lifetime, and cleared explicitly on sync so a
 * newly configured token is reflected immediately rather than after a wait.
 */
const CONNECTION_CACHE_MS = 5 * 60 * 1000;

interface ResolvedConnection {
  provider: GitHubProvider;
  connection: GitHubConnection;
  credentialSource: CredentialSource;
}

let connectionCache: { at: number; value: ResolvedConnection } | null = null;

export function invalidateConnectionCache(): void {
  connectionCache = null;
}

/**
 * Picks the provider to actually read from, after checking that it works.
 *
 * A configured token can be stale, revoked or too narrowly scoped. Rather than
 * letting the whole hub fail on it, the connection is probed once and a rejected
 * token falls back to the demo provider — with the real reason preserved in
 * `connection.detail` so the UI can tell you exactly what to fix.
 */
async function resolveProvider(): Promise<ResolvedConnection> {
  if (connectionCache && Date.now() - connectionCache.at < CONNECTION_CACHE_MS) {
    return connectionCache.value;
  }

  const resolved = await probeProvider();
  connectionCache = { at: Date.now(), value: resolved };
  return resolved;
}

async function probeProvider(): Promise<ResolvedConnection> {
  const { provider: configured, credentialSource } = resolveGitHubProvider();
  const connection = await configured.getConnection();

  if (connection.connected || configured.mode === "demo") {
    return { provider: configured, connection, credentialSource };
  }

  const fallback = new DemoGitHubProvider();
  return {
    provider: fallback,
    credentialSource,
    connection: {
      ...connection,
      mode: "demo",
      connected: false,
      detail: `${connection.detail} Falling back to demo repositories until a working token is configured.`,
    },
  };
}

/** Which credential the hub and settings screens are currently using. */
export async function getCredentialSource(): Promise<CredentialSource> {
  return (await resolveProvider()).credentialSource;
}

export async function getConnection(): Promise<GitHubConnection> {
  return (await resolveProvider()).connection;
}

/** Repositories from the local cache, most recently pushed first. */
export async function listCachedRepositories(): Promise<HubRepository[]> {
  const rows = db
    .select()
    .from(githubRepositories)
    .orderBy(desc(githubRepositories.pushedAt))
    .all();
  return rows.map(rowToHub);
}

export async function findCachedRepository(
  externalId: string,
): Promise<HubRepository | null> {
  const row = db
    .select()
    .from(githubRepositories)
    .where(eq(githubRepositories.externalId, externalId))
    .get();
  return row ? rowToHub(row) : null;
}

/**
 * Pulls repositories from the active provider into the local cache.
 *
 * Upstream metadata is refreshed on every sync; the `linkedProjectId` link and
 * any user edits on the linked project are never touched.
 */
export async function syncRepositories(): Promise<SyncResult> {
  // Syncing is the moment credentials are most likely to have just changed.
  invalidateConnectionCache();
  const { provider, connection } = await resolveProvider();
  const repos = await provider.listRepositories();
  const syncedAt = new Date().toISOString();

  /*
   * Whether this sync actually spoke to GitHub as somebody.
   *
   * This is the load-bearing distinction. `resolveProvider` deliberately falls
   * back to demo data when a token is rejected, so that a stale credential
   * degrades the hub instead of breaking it. But that means an unauthenticated
   * sync returns the demo set — and pruning against it would delete every real
   * repository the cache holds, turning an expired token into data loss.
   *
   * So an unauthenticated sync refreshes and inserts, and never deletes.
   */
  const authenticated = connection.connected && provider.mode !== "demo";
  const isDemo = !authenticated;

  let created = 0;
  let updated = 0;
  let removed = 0;
  const linkedToRefresh: Array<{ projectId: string; repo: GitHubRepository }> = [];

  /*
   * One transaction for the whole cache rewrite.
   *
   * A sync interrupted halfway used to leave the cache holding some rows from
   * the new response and some from the old, with no way to tell which. Grouping
   * the writes means an interrupted sync changes nothing at all.
   *
   * better-sqlite3 transactions are synchronous, so the linked-project updates
   * — which go through the async repository — are collected here and applied
   * after it commits. They are idempotent metadata refreshes, so running them
   * outside the transaction cannot corrupt anything.
   */
  db.transaction(() => {
    for (const repo of repos) {
      const existing = db
        .select()
        .from(githubRepositories)
        .where(eq(githubRepositories.externalId, repo.externalId))
        .get();

      const values = {
        externalId: repo.externalId,
        name: repo.name,
        fullName: repo.fullName,
        owner: repo.owner,
        description: repo.description,
        language: repo.language,
        stars: repo.stars,
        forks: repo.forks,
        openIssues: repo.openIssues,
        isPrivate: repo.isPrivate,
        isArchived: repo.isArchived,
        isFork: repo.isFork,
        defaultBranch: repo.defaultBranch,
        htmlUrl: repo.htmlUrl,
        homepage: repo.homepage,
        topics: JSON.stringify(repo.topics),
        pushedAt: repo.pushedAt,
        updatedAt: repo.updatedAt,
        syncedAt,
        isDemo,
      };

      if (existing) {
        db.update(githubRepositories)
          .set(values)
          .where(eq(githubRepositories.externalId, repo.externalId))
          .run();
        updated += 1;

        if (existing.linkedProjectId) {
          linkedToRefresh.push({ projectId: existing.linkedProjectId, repo });
        }
      } else {
        db.insert(githubRepositories)
          .values({ id: createId("ghr"), ...values })
          .run();
        created += 1;
      }
    }

    /*
     * Drop cached rows the provider no longer returns — repositories deleted on
     * GitHub, access revoked, or leftover demo rows once a real token works.
     *
     * Two guards. A linked row is kept regardless: the project and the user's
     * notes on it must never vanish because upstream did. And an unauthenticated
     * sync skips this entirely, because it has no authoritative list to compare
     * against — see `authenticated` above.
     */
    if (authenticated) {
      const fetchedIds = new Set(repos.map((repo) => repo.externalId));
      const cachedRows = db
        .select({
          externalId: githubRepositories.externalId,
          linkedProjectId: githubRepositories.linkedProjectId,
        })
        .from(githubRepositories)
        .all();

      for (const row of cachedRows) {
        if (fetchedIds.has(row.externalId) || row.linkedProjectId) continue;
        db.delete(githubRepositories)
          .where(eq(githubRepositories.externalId, row.externalId))
          .run();
        removed += 1;
      }
    }

    db.insert(activityEvents)
      .values({
        id: createId("act"),
        projectId: null,
        type: "github.synced",
        message: authenticated
          ? `Synced ${repos.length} GitHub ${repos.length === 1 ? "repository" : "repositories"}`
          : "GitHub sync ran without a working token — cached repositories were left untouched",
        metadata: JSON.stringify({
          created,
          updated,
          removed,
          mode: connection.mode,
          authenticated,
        }),
        createdAt: syncedAt,
      })
      .run();
  });

  // Keep already-linked projects' upstream fields in step. Outside the
  // transaction because the repository interface is async by design.
  for (const { projectId, repo } of linkedToRefresh) {
    await projectRepository.update(projectId, {
      description: repo.description,
      repositoryUrl: repo.htmlUrl,
      projectUrl: repo.homepage,
      syncedAt,
      metadata: repositoryMetadata(repo),
    });
  }

  return {
    connection,
    fetched: repos.length,
    created,
    updated,
    removed,
    syncedAt,
    pruned: authenticated,
  };
}

/** The subset of GitHub data worth carrying on the Project record. */
function repositoryMetadata(repo: GitHubRepository): Record<string, unknown> {
  return {
    github: {
      externalId: repo.externalId,
      fullName: repo.fullName,
      owner: repo.owner,
      language: repo.language,
      stars: repo.stars,
      forks: repo.forks,
      openIssues: repo.openIssues,
      isPrivate: repo.isPrivate,
      isFork: repo.isFork,
      defaultBranch: repo.defaultBranch,
      htmlUrl: repo.htmlUrl,
      topics: repo.topics,
      pushedAt: repo.pushedAt,
    },
  };
}

/**
 * Adds a cached repository to the dashboard as a first-class project.
 * Idempotent: calling it twice returns the existing project.
 */
export async function linkRepositoryToProject(externalId: string) {
  const repo = await findCachedRepository(externalId);
  if (!repo) throw new Error(`Repository ${externalId} is not in the local cache`);

  if (repo.linkedProjectId) {
    const existing = await projectRepository.findById(repo.linkedProjectId);
    if (existing) return existing;
  }

  const project = await projectRepository.create({
    name: repo.name,
    description: repo.description,
    source: "github",
    type: "software",
    status: repo.isArchived ? "archived" : "active",
    tags: repo.topics.slice(0, 8),
    repositoryUrl: repo.htmlUrl,
    projectUrl: repo.homepage,
    externalId: repo.externalId,
    syncedAt: repo.syncedAt,
    archived: repo.isArchived,
    metadata: repositoryMetadata(repo),
  });

  db.update(githubRepositories)
    .set({ linkedProjectId: project.id })
    .where(eq(githubRepositories.externalId, externalId))
    .run();

  return project;
}

/** Removes the dashboard project but keeps the cached repository. */
export async function unlinkRepository(externalId: string): Promise<void> {
  const repo = await findCachedRepository(externalId);
  if (!repo?.linkedProjectId) return;
  await projectRepository.delete(repo.linkedProjectId);
  db.update(githubRepositories)
    .set({ linkedProjectId: null })
    .where(eq(githubRepositories.externalId, externalId))
    .run();
}

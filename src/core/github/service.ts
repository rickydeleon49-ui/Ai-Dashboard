import "server-only";

import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { activityEvents, githubRepositories } from "@/db/schema";
import type { GithubRepositoryRow } from "@/db/schema";
import { projectRepository } from "@/db/repositories";
import { createId } from "@/lib/ids";
import { getGitHubProvider } from "./provider";
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
  syncedAt: string;
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

/**
 * Picks the provider to actually read from, after checking that it works.
 *
 * A configured token can be stale, revoked or too narrowly scoped. Rather than
 * letting the whole hub fail on it, the connection is probed once and a rejected
 * token falls back to the demo provider — with the real reason preserved in
 * `connection.detail` so the UI can tell you exactly what to fix.
 */
async function resolveProvider(): Promise<{
  provider: GitHubProvider;
  connection: GitHubConnection;
}> {
  const configured = getGitHubProvider();
  const connection = await configured.getConnection();

  if (connection.connected || configured.mode === "demo") {
    return { provider: configured, connection };
  }

  const fallback = new DemoGitHubProvider();
  return {
    provider: fallback,
    connection: {
      ...connection,
      mode: "demo",
      connected: false,
      detail: `${connection.detail} Falling back to demo repositories until a working token is configured.`,
    },
  };
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
  const { provider, connection } = await resolveProvider();
  const repos = await provider.listRepositories();
  const syncedAt = new Date().toISOString();

  let created = 0;
  let updated = 0;

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
    };

    if (existing) {
      db.update(githubRepositories)
        .set(values)
        .where(eq(githubRepositories.externalId, repo.externalId))
        .run();
      updated += 1;

      // Keep an already-linked project's upstream fields in step.
      if (existing.linkedProjectId) {
        await projectRepository.update(existing.linkedProjectId, {
          description: repo.description,
          repositoryUrl: repo.htmlUrl,
          projectUrl: repo.homepage,
          syncedAt,
          metadata: repositoryMetadata(repo),
        });
      }
    } else {
      db.insert(githubRepositories)
        .values({ id: createId("ghr"), ...values })
        .run();
      created += 1;
    }
  }

  db.insert(activityEvents)
    .values({
      id: createId("act"),
      projectId: null,
      type: "github.synced",
      message: `Synced ${repos.length} GitHub ${repos.length === 1 ? "repository" : "repositories"}`,
      metadata: JSON.stringify({ created, updated, mode: connection.mode }),
      createdAt: syncedAt,
    })
    .run();

  return { connection, fetched: repos.length, created, updated, syncedAt };
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

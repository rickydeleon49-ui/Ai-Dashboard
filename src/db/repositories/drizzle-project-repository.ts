import { and, desc, asc, eq, inArray, like, or, sql } from "drizzle-orm";
import { db } from "../client";
import { activityEvents, projectTags, projects, tags } from "../schema";
import type { ProjectRow } from "../schema";
import type { ProjectRepository, TagCount } from "./project-repository";
import type {
  Project,
  ProjectCreateInput,
  ProjectQuery,
  ProjectSource,
  ProjectStats,
  ProjectStatus,
  ProjectType,
  ProjectUpdateInput,
} from "@/core/projects/types";
import { PROJECT_STATUSES } from "@/core/projects/types";
import { createId } from "@/lib/ids";

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Maps a database row plus its tags into the domain model. */
function toDomain(row: ProjectRow, tagNames: string[]): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    source: row.source as ProjectSource,
    type: row.type as ProjectType,
    status: row.status as ProjectStatus,
    tags: tagNames,
    repositoryUrl: row.repositoryUrl,
    projectUrl: row.projectUrl,
    localPath: row.localPath,
    notes: row.notes,
    favorite: row.favorite,
    archived: row.archived,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastOpenedAt: row.lastOpenedAt,
    externalId: row.externalId,
    syncedAt: row.syncedAt,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
  };
}

/** Loads tag names for a set of projects in one query. */
function loadTags(projectIds: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (projectIds.length === 0) return map;

  const rows = db
    .select({ projectId: projectTags.projectId, name: tags.name })
    .from(projectTags)
    .innerJoin(tags, eq(projectTags.tagId, tags.id))
    .where(inArray(projectTags.projectId, projectIds))
    .all();

  for (const row of rows) {
    const list = map.get(row.projectId) ?? [];
    list.push(row.name);
    map.set(row.projectId, list);
  }
  for (const list of map.values()) list.sort();
  return map;
}

/** Upserts tag rows and rewrites a project's tag associations. */
function syncTags(projectId: string, tagNames: string[]): void {
  db.delete(projectTags).where(eq(projectTags.projectId, projectId)).run();
  if (tagNames.length === 0) return;

  for (const name of tagNames) {
    const existing = db.select().from(tags).where(eq(tags.name, name)).get();
    const tagId = existing?.id ?? createId("tag");
    if (!existing) {
      db.insert(tags).values({ id: tagId, name }).run();
    }
    db.insert(projectTags).values({ projectId, tagId }).onConflictDoNothing().run();
  }
}

function recordActivity(
  projectId: string | null,
  type: string,
  message: string,
  metadata: Record<string, unknown> = {},
): void {
  db.insert(activityEvents)
    .values({
      id: createId("act"),
      projectId,
      type,
      message,
      metadata: JSON.stringify(metadata),
      createdAt: nowIso(),
    })
    .run();
}

/**
 * SQLite-backed implementation of {@link ProjectRepository}.
 *
 * better-sqlite3 is synchronous; the async signatures exist so that a networked
 * implementation can be dropped in without touching a single caller.
 */
export class DrizzleProjectRepository implements ProjectRepository {
  async list(query: ProjectQuery = {}): Promise<Project[]> {
    const conditions = [];

    if (!query.includeArchived) {
      conditions.push(eq(projects.archived, false));
    }
    if (query.source && query.source !== "all") {
      conditions.push(eq(projects.source, query.source));
    }
    if (query.status && query.status !== "all") {
      conditions.push(eq(projects.status, query.status));
    }
    if (query.type && query.type !== "all") {
      conditions.push(eq(projects.type, query.type));
    }
    if (query.favorite) {
      conditions.push(eq(projects.favorite, true));
    }
    if (query.sort === "opened") {
      conditions.push(sql`${projects.lastOpenedAt} is not null`);
    }

    if (query.search) {
      // Search names, descriptions, notes and tags. The tag arm uses a subquery
      // so that a tag match surfaces the project even when the text does not.
      const needle = `%${query.search.toLowerCase()}%`;
      conditions.push(
        or(
          like(sql`lower(${projects.name})`, needle),
          like(sql`lower(coalesce(${projects.description}, ''))`, needle),
          like(sql`lower(coalesce(${projects.notes}, ''))`, needle),
          like(sql`lower(coalesce(${projects.repositoryUrl}, ''))`, needle),
          sql`${projects.id} in (
            select ${projectTags.projectId} from ${projectTags}
            inner join ${tags} on ${tags.id} = ${projectTags.tagId}
            where ${tags.name} like ${needle}
          )`,
        )!,
      );
    }

    if (query.tag) {
      const tagName = query.tag.toLowerCase();
      conditions.push(
        sql`${projects.id} in (
          select ${projectTags.projectId} from ${projectTags}
          inner join ${tags} on ${tags.id} = ${projectTags.tagId}
          where ${tags.name} = ${tagName}
        )`,
      );
    }

    const orderBy = (() => {
      switch (query.sort) {
        case "created":
          return [desc(projects.createdAt)];
        case "opened":
          return [desc(projects.lastOpenedAt)];
        case "name":
          return [asc(sql`lower(${projects.name})`)];
        case "status":
          return [asc(projects.status), desc(projects.updatedAt)];
        default:
          return [desc(projects.updatedAt)];
      }
    })();

    let statement = db
      .select()
      .from(projects)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(...orderBy)
      .$dynamic();

    if (query.limit) statement = statement.limit(query.limit);

    const rows = statement.all();
    const tagMap = loadTags(rows.map((r) => r.id));
    return rows.map((row) => toDomain(row, tagMap.get(row.id) ?? []));
  }

  async findById(id: string): Promise<Project | null> {
    const row = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) return null;
    return toDomain(row, loadTags([row.id]).get(row.id) ?? []);
  }

  async findByExternalId(
    source: string,
    externalId: string,
  ): Promise<Project | null> {
    const row = db
      .select()
      .from(projects)
      .where(and(eq(projects.source, source), eq(projects.externalId, externalId)))
      .get();
    if (!row) return null;
    return toDomain(row, loadTags([row.id]).get(row.id) ?? []);
  }

  async create(input: ProjectCreateInput): Promise<Project> {
    const id = createId("prj");
    const timestamp = nowIso();
    const tagNames = input.tags ?? [];

    db.transaction((tx) => {
      tx.insert(projects)
        .values({
          id,
          name: input.name,
          description: input.description ?? null,
          source: input.source ?? "manual",
          type: input.type ?? "software",
          status: input.status ?? "idea",
          repositoryUrl: input.repositoryUrl ?? null,
          projectUrl: input.projectUrl ?? null,
          localPath: input.localPath ?? null,
          notes: input.notes ?? null,
          favorite: input.favorite ?? false,
          archived: input.archived ?? false,
          createdAt: input.createdAt ?? timestamp,
          updatedAt: input.updatedAt ?? timestamp,
          lastOpenedAt: input.lastOpenedAt ?? null,
          externalId: input.externalId ?? null,
          syncedAt: input.syncedAt ?? null,
          metadata: JSON.stringify(input.metadata ?? {}),
        })
        .run();
      return true;
    });

    syncTags(id, tagNames);
    recordActivity(id, "project.created", `Created ${input.name}`, {
      source: input.source ?? "manual",
    });

    const created = await this.findById(id);
    if (!created) throw new Error("Failed to read back created project");
    return created;
  }

  async update(id: string, input: ProjectUpdateInput): Promise<Project | null> {
    const existing = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!existing) return null;

    const patch: Partial<ProjectRow> = { updatedAt: nowIso() };

    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.source !== undefined) patch.source = input.source;
    if (input.type !== undefined) patch.type = input.type;
    if (input.status !== undefined) patch.status = input.status;
    if (input.repositoryUrl !== undefined) patch.repositoryUrl = input.repositoryUrl;
    if (input.projectUrl !== undefined) patch.projectUrl = input.projectUrl;
    if (input.localPath !== undefined) patch.localPath = input.localPath;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.favorite !== undefined) patch.favorite = input.favorite;
    if (input.archived !== undefined) patch.archived = input.archived;
    if (input.lastOpenedAt !== undefined) patch.lastOpenedAt = input.lastOpenedAt;
    if (input.externalId !== undefined) patch.externalId = input.externalId;
    if (input.syncedAt !== undefined) patch.syncedAt = input.syncedAt;
    if (input.metadata !== undefined) {
      patch.metadata = JSON.stringify(input.metadata);
    }

    db.update(projects).set(patch).where(eq(projects.id, id)).run();
    if (input.tags !== undefined) syncTags(id, input.tags);

    // Status changes and archiving are the transitions worth showing in a feed.
    if (input.status !== undefined && input.status !== existing.status) {
      recordActivity(id, "project.status", `${existing.name} → ${input.status}`, {
        from: existing.status,
        to: input.status,
      });
    } else if (input.archived === true && !existing.archived) {
      recordActivity(id, "project.archived", `Archived ${existing.name}`);
    } else {
      recordActivity(id, "project.updated", `Updated ${patch.name ?? existing.name}`);
    }

    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const existing = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!existing) return false;
    db.delete(projects).where(eq(projects.id, id)).run();
    recordActivity(null, "project.deleted", `Deleted ${existing.name}`);
    return true;
  }

  async markOpened(id: string): Promise<Project | null> {
    const existing = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!existing) return null;

    db.update(projects)
      .set({ lastOpenedAt: nowIso() })
      .where(eq(projects.id, id))
      .run();
    recordActivity(id, "project.opened", `Opened ${existing.name}`);
    return this.findById(id);
  }

  async stats(): Promise<ProjectStats> {
    const rows = db
      .select({
        source: projects.source,
        status: projects.status,
        favorite: projects.favorite,
        archived: projects.archived,
      })
      .from(projects)
      .all();

    const byStatus = Object.fromEntries(
      PROJECT_STATUSES.map((s) => [s, 0]),
    ) as Record<ProjectStatus, number>;

    const stats: ProjectStats = {
      total: 0,
      active: 0,
      github: 0,
      uploaded: 0,
      manual: 0,
      favorites: 0,
      archived: 0,
      completed: 0,
      byStatus,
    };

    for (const row of rows) {
      if (row.archived) {
        stats.archived += 1;
        // Archived projects are excluded from every other headline count.
        byStatus.archived += 1;
        continue;
      }
      stats.total += 1;
      byStatus[row.status as ProjectStatus] =
        (byStatus[row.status as ProjectStatus] ?? 0) + 1;
      if (row.status === "active") stats.active += 1;
      if (row.status === "completed") stats.completed += 1;
      if (row.favorite) stats.favorites += 1;
      if (row.source === "github") stats.github += 1;
      if (row.source === "uploaded") stats.uploaded += 1;
      if (row.source === "manual") stats.manual += 1;
    }

    return stats;
  }

  async allTags(): Promise<TagCount[]> {
    const rows = db
      .select({ name: tags.name, count: sql<number>`count(${projectTags.projectId})` })
      .from(tags)
      .leftJoin(projectTags, eq(projectTags.tagId, tags.id))
      .groupBy(tags.name)
      .orderBy(desc(sql`count(${projectTags.projectId})`), asc(tags.name))
      .all();
    return rows.filter((r) => r.count > 0);
  }
}

import { and, desc, asc, eq, inArray, like, or, sql } from "drizzle-orm";
import { db } from "../client";
import { activityEvents, projectTags, projects, prompts, tags } from "../schema";
import type { ProjectRow } from "../schema";
import {
  LOCAL_WORKSPACE_ID,
  type ProjectRepository,
  type ProjectSummary,
  type TagCount,
} from "./project-repository";
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
import { isProjectStatus, PROJECT_STATUSES } from "@/core/projects/types";
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

/**
 * How many events to keep. The feed shows a dozen at a time and the detail page
 * twenty, so this is generous — it exists to stop an append-only table growing
 * without limit over years of use.
 */
const ACTIVITY_RETENTION = 1000;

/** Prune every so often rather than on each write; the cap is not exact. */
const PRUNE_INTERVAL = 50;
let writesSincePrune = 0;

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

  writesSincePrune += 1;
  if (writesSincePrune < PRUNE_INTERVAL) return;
  writesSincePrune = 0;

  // Delete everything older than the newest ACTIVITY_RETENTION rows. The
  // subquery reads a single row through the created_at index, so this stays
  // cheap regardless of how large the table has become.
  db.run(sql`
    delete from ${activityEvents}
    where ${activityEvents.createdAt} < (
      select ${activityEvents.createdAt} from ${activityEvents}
      order by ${activityEvents.createdAt} desc
      limit 1 offset ${ACTIVITY_RETENTION}
    )
  `);
}

/**
 * SQLite is single-tenant forever (see LOCAL_WORKSPACE_ID's own comment) —
 * this is a loud programming error, not a real authorization boundary. A
 * real cross-tenant leak is impossible here by construction: SQLite has no
 * `workspace_id` column to leak from, since exactly one install-wide
 * "workspace" exists. Any other value can only mean a caller was wired up
 * for hosted multi-user mode without switching to PostgresProjectRepository.
 */
function assertLocalWorkspace(workspaceId: string): void {
  if (workspaceId !== LOCAL_WORKSPACE_ID) {
    throw new Error(
      `DrizzleProjectRepository (SQLite) only serves "${LOCAL_WORKSPACE_ID}"; got "${workspaceId}". ` +
        "Hosted multi-user mode must use PostgresProjectRepository instead.",
    );
  }
}

/**
 * SQLite-backed implementation of {@link ProjectRepository}.
 *
 * better-sqlite3 is synchronous; the async signatures exist so that a networked
 * implementation can be dropped in without touching a single caller.
 */
export class DrizzleProjectRepository implements ProjectRepository {
  async list(workspaceId: string, query: ProjectQuery = {}): Promise<Project[]> {
    assertLocalWorkspace(workspaceId);
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

  async listSummaries(workspaceId: string, limit = 500): Promise<ProjectSummary[]> {
    assertLocalWorkspace(workspaceId);
    return db
      .select({
        id: projects.id,
        name: projects.name,
        source: projects.source,
        status: projects.status,
      })
      .from(projects)
      .orderBy(desc(projects.updatedAt))
      .limit(limit)
      .all();
  }

  async findById(workspaceId: string, id: string): Promise<Project | null> {
    assertLocalWorkspace(workspaceId);
    const row = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) return null;
    return toDomain(row, loadTags([row.id]).get(row.id) ?? []);
  }

  async findByExternalId(
    workspaceId: string,
    source: string,
    externalId: string,
  ): Promise<Project | null> {
    assertLocalWorkspace(workspaceId);
    const row = db
      .select()
      .from(projects)
      .where(and(eq(projects.source, source), eq(projects.externalId, externalId)))
      .get();
    if (!row) return null;
    return toDomain(row, loadTags([row.id]).get(row.id) ?? []);
  }

  async create(workspaceId: string, input: ProjectCreateInput): Promise<Project> {
    assertLocalWorkspace(workspaceId);
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

    const created = await this.findById(workspaceId, id);
    if (!created) throw new Error("Failed to read back created project");
    return created;
  }

  async update(
    workspaceId: string,
    id: string,
    input: ProjectUpdateInput,
  ): Promise<Project | null> {
    assertLocalWorkspace(workspaceId);
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

    /*
     * Archiving and restoring have to keep `archived` and `status` agreeing.
     *
     * Archiving sets status to "archived" so the badge and filters match the
     * flag. Restoring therefore has to put a real status back, or the project
     * returns to the library still reading "Archived" — visible in the badge,
     * in the status filter, and in the dashboard's per-status counts, while the
     * archive itself is empty.
     *
     * The status held before archiving is remembered on the row so restoring
     * returns the project to where it actually was. "active" is the fallback
     * for anything archived before this was recorded.
     */
    const archiveMetadata = parseJson<Record<string, unknown>>(existing.metadata, {});

    if (input.archived === true && !existing.archived) {
      if (existing.status !== "archived") {
        archiveMetadata.statusBeforeArchive = existing.status;
      }
      if (input.status === undefined) patch.status = "archived";
      patch.metadata = JSON.stringify(archiveMetadata);
    } else if (input.archived === false && existing.archived) {
      if (input.status === undefined) {
        const remembered = archiveMetadata.statusBeforeArchive;
        patch.status = isProjectStatus(remembered) ? remembered : "active";
      }
      delete archiveMetadata.statusBeforeArchive;
      patch.metadata = JSON.stringify(archiveMetadata);
    }

    if (input.lastOpenedAt !== undefined) patch.lastOpenedAt = input.lastOpenedAt;
    if (input.externalId !== undefined) patch.externalId = input.externalId;
    if (input.syncedAt !== undefined) patch.syncedAt = input.syncedAt;
    if (input.metadata !== undefined) {
      // An explicit metadata patch wins, but must not drop the archive
      // bookkeeping written above — that is what restore reads.
      const explicit: Record<string, unknown> = { ...input.metadata };
      if (archiveMetadata.statusBeforeArchive !== undefined) {
        explicit.statusBeforeArchive = archiveMetadata.statusBeforeArchive;
      }
      patch.metadata = JSON.stringify(explicit);
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

    return this.findById(workspaceId, id);
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    assertLocalWorkspace(workspaceId);
    const existing = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!existing) return false;
    db.delete(projects).where(eq(projects.id, id)).run();
    recordActivity(null, "project.deleted", `Deleted ${existing.name}`);
    return true;
  }

  async markOpened(workspaceId: string, id: string): Promise<Project | null> {
    assertLocalWorkspace(workspaceId);
    const existing = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!existing) return null;

    db.update(projects)
      .set({ lastOpenedAt: nowIso() })
      .where(eq(projects.id, id))
      .run();
    recordActivity(id, "project.opened", `Opened ${existing.name}`);
    return this.findById(workspaceId, id);
  }

  async stats(workspaceId: string): Promise<ProjectStats> {
    assertLocalWorkspace(workspaceId);
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

    // One extra scalar read rather than a second source threaded through every
    // consumer of stats; see the note on ProjectStats.
    const promptCount =
      db.get<{ c: number }>(sql`select count(*) as c from ${prompts}`)?.c ?? 0;

    const stats: ProjectStats = {
      total: 0,
      prompts: promptCount,
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

  async allTags(workspaceId: string): Promise<TagCount[]> {
    assertLocalWorkspace(workspaceId);
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

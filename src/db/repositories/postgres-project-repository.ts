import "server-only";

import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { getPgDb } from "../pg-client";
import { activityEvents, projectTags, projects, tags } from "../schema.pg";
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
import type { ProjectRepository, ProjectSummary, TagCount } from "./project-repository";

type ProjectRow = typeof projects.$inferSelect;

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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastOpenedAt: row.lastOpenedAt?.toISOString() ?? null,
    externalId: row.externalId,
    syncedAt: row.syncedAt?.toISOString() ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  };
}

/**
 * Postgres-backed, genuinely workspace-scoped implementation of
 * {@link ProjectRepository} — hosted multi-user mode. Mirrors
 * DrizzleProjectRepository's (SQLite) behavior closely so the two are
 * interchangeable from a caller's perspective; every query here additionally
 * filters on workspaceId, which SQLite has no column for at all (see
 * LOCAL_WORKSPACE_ID's own comment in ./project-repository).
 */
export class PostgresProjectRepository implements ProjectRepository {
  async list(workspaceId: string, query: ProjectQuery = {}): Promise<Project[]> {
    const db = getPgDb();
    const conditions = [eq(projects.workspaceId, workspaceId)];

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
      // Search names, descriptions, notes and tags. The tag arm uses a
      // subquery so that a tag match surfaces the project even when the
      // text does not — both arms stay workspace-scoped.
      const needle = `%${query.search}%`;
      const searchCondition = or(
        ilike(projects.name, needle),
        ilike(sql`coalesce(${projects.description}, '')`, needle),
        ilike(sql`coalesce(${projects.notes}, '')`, needle),
        ilike(sql`coalesce(${projects.repositoryUrl}, '')`, needle),
        sql`${projects.id} in (
          select ${projectTags.projectId} from ${projectTags}
          inner join ${tags} on ${tags.id} = ${projectTags.tagId}
          where ${tags.workspaceId} = ${workspaceId} and ${tags.name} ilike ${needle}
        )`,
      );
      if (searchCondition) conditions.push(searchCondition);
    }

    if (query.tag) {
      const tagName = query.tag.toLowerCase();
      conditions.push(
        sql`${projects.id} in (
          select ${projectTags.projectId} from ${projectTags}
          inner join ${tags} on ${tags.id} = ${projectTags.tagId}
          where ${tags.workspaceId} = ${workspaceId} and ${tags.name} = ${tagName}
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
      .where(and(...conditions))
      .orderBy(...orderBy)
      .$dynamic();

    if (query.limit) statement = statement.limit(query.limit);

    const rows = await statement;
    const tagMap = await this.loadTags(
      workspaceId,
      rows.map((r) => r.id),
    );
    return rows.map((row) => toDomain(row, tagMap.get(row.id) ?? []));
  }

  async listSummaries(workspaceId: string, limit = 500): Promise<ProjectSummary[]> {
    const db = getPgDb();
    return db
      .select({
        id: projects.id,
        name: projects.name,
        source: projects.source,
        status: projects.status,
      })
      .from(projects)
      .where(eq(projects.workspaceId, workspaceId))
      .orderBy(desc(projects.updatedAt))
      .limit(limit);
  }

  async findById(workspaceId: string, id: string): Promise<Project | null> {
    const db = getPgDb();
    const [row] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id)))
      .limit(1);
    if (!row) return null;
    const tagMap = await this.loadTags(workspaceId, [row.id]);
    return toDomain(row, tagMap.get(row.id) ?? []);
  }

  async findByExternalId(
    workspaceId: string,
    source: string,
    externalId: string,
  ): Promise<Project | null> {
    const db = getPgDb();
    const [row] = await db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, workspaceId),
          eq(projects.source, source),
          eq(projects.externalId, externalId),
        ),
      )
      .limit(1);
    if (!row) return null;
    const tagMap = await this.loadTags(workspaceId, [row.id]);
    return toDomain(row, tagMap.get(row.id) ?? []);
  }

  async create(workspaceId: string, input: ProjectCreateInput): Promise<Project> {
    const db = getPgDb();
    const id = createId("prj");
    const now = new Date();
    const tagNames = input.tags ?? [];

    await db.insert(projects).values({
      id,
      workspaceId,
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
      createdAt: input.createdAt ? new Date(input.createdAt) : now,
      updatedAt: input.updatedAt ? new Date(input.updatedAt) : now,
      lastOpenedAt: input.lastOpenedAt ? new Date(input.lastOpenedAt) : null,
      externalId: input.externalId ?? null,
      syncedAt: input.syncedAt ? new Date(input.syncedAt) : null,
      metadata: input.metadata ?? {},
    });

    await this.syncTags(workspaceId, id, tagNames);
    await this.recordActivity(workspaceId, id, "project.created", `Created ${input.name}`, {
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
    const db = getPgDb();
    const [existing] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id)))
      .limit(1);
    if (!existing) return null;

    const patch: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };

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

    // See DrizzleProjectRepository.update for why archiving/restoring must
    // keep `archived` and `status` in sync — identical logic, just against
    // a jsonb column instead of a JSON-encoded text one.
    const archiveMetadata = { ...((existing.metadata as Record<string, unknown>) ?? {}) };

    if (input.archived === true && !existing.archived) {
      if (existing.status !== "archived") {
        archiveMetadata.statusBeforeArchive = existing.status;
      }
      if (input.status === undefined) patch.status = "archived";
      patch.metadata = archiveMetadata;
    } else if (input.archived === false && existing.archived) {
      if (input.status === undefined) {
        const remembered = archiveMetadata.statusBeforeArchive;
        patch.status = isProjectStatus(remembered) ? remembered : "active";
      }
      delete archiveMetadata.statusBeforeArchive;
      patch.metadata = archiveMetadata;
    }

    if (input.lastOpenedAt !== undefined) {
      patch.lastOpenedAt = input.lastOpenedAt ? new Date(input.lastOpenedAt) : null;
    }
    if (input.externalId !== undefined) patch.externalId = input.externalId;
    if (input.syncedAt !== undefined) {
      patch.syncedAt = input.syncedAt ? new Date(input.syncedAt) : null;
    }
    if (input.metadata !== undefined) {
      const explicit: Record<string, unknown> = { ...input.metadata };
      if (archiveMetadata.statusBeforeArchive !== undefined) {
        explicit.statusBeforeArchive = archiveMetadata.statusBeforeArchive;
      }
      patch.metadata = explicit;
    }

    await db
      .update(projects)
      .set(patch)
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id)));
    if (input.tags !== undefined) await this.syncTags(workspaceId, id, input.tags);

    if (input.status !== undefined && input.status !== existing.status) {
      await this.recordActivity(
        workspaceId,
        id,
        "project.status",
        `${existing.name} → ${input.status}`,
        { from: existing.status, to: input.status },
      );
    } else if (input.archived === true && !existing.archived) {
      await this.recordActivity(workspaceId, id, "project.archived", `Archived ${existing.name}`);
    } else {
      await this.recordActivity(
        workspaceId,
        id,
        "project.updated",
        `Updated ${patch.name ?? existing.name}`,
      );
    }

    return this.findById(workspaceId, id);
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    const db = getPgDb();
    const [existing] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id)))
      .limit(1);
    if (!existing) return false;
    await db
      .delete(projects)
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id)));
    await this.recordActivity(workspaceId, null, "project.deleted", `Deleted ${existing.name}`);
    return true;
  }

  async markOpened(workspaceId: string, id: string): Promise<Project | null> {
    const db = getPgDb();
    const [existing] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id)))
      .limit(1);
    if (!existing) return null;

    await db
      .update(projects)
      .set({ lastOpenedAt: new Date() })
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id)));
    await this.recordActivity(workspaceId, id, "project.opened", `Opened ${existing.name}`);
    return this.findById(workspaceId, id);
  }

  async stats(workspaceId: string): Promise<ProjectStats> {
    const db = getPgDb();
    const rows = await db
      .select({
        source: projects.source,
        status: projects.status,
        favorite: projects.favorite,
        archived: projects.archived,
      })
      .from(projects)
      .where(eq(projects.workspaceId, workspaceId));

    const byStatus = Object.fromEntries(
      PROJECT_STATUSES.map((s) => [s, 0]),
    ) as Record<ProjectStatus, number>;

    // Prompts are workspace-scoped once Phase 3 ports that domain; until
    // then there is no Postgres prompts table to count, so this reports 0
    // rather than reading a global SQLite number that belongs to a
    // different install entirely.
    const promptCount = 0;

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
        byStatus.archived += 1;
        continue;
      }
      stats.total += 1;
      byStatus[row.status as ProjectStatus] = (byStatus[row.status as ProjectStatus] ?? 0) + 1;
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
    const db = getPgDb();
    // Postgres's count(...) is a bigint, which node-postgres returns as a
    // string rather than risk silent precision loss on a JS number — cast
    // to int here (a tag's project count will never approach that range)
    // so callers get the real number TagCount promises, not "2" > 0 always
    // being true regardless of what it says.
    const rows = await db
      .select({
        name: tags.name,
        count: sql<number>`count(${projectTags.projectId})::int`,
      })
      .from(tags)
      .leftJoin(projectTags, eq(projectTags.tagId, tags.id))
      .where(eq(tags.workspaceId, workspaceId))
      .groupBy(tags.name)
      .orderBy(desc(sql`count(${projectTags.projectId})`), asc(tags.name));
    return rows.filter((r) => r.count > 0);
  }

  /** Loads tag names for a set of projects in one query, scoped to workspaceId. */
  private async loadTags(
    workspaceId: string,
    projectIds: string[],
  ): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (projectIds.length === 0) return map;

    const db = getPgDb();
    const rows = await db
      .select({ projectId: projectTags.projectId, name: tags.name })
      .from(projectTags)
      .innerJoin(tags, eq(projectTags.tagId, tags.id))
      .where(and(eq(projectTags.workspaceId, workspaceId), inArray(projectTags.projectId, projectIds)));

    for (const row of rows) {
      const list = map.get(row.projectId) ?? [];
      list.push(row.name);
      map.set(row.projectId, list);
    }
    for (const list of map.values()) list.sort();
    return map;
  }

  /** Upserts tag rows and rewrites a project's tag associations, scoped to workspaceId. */
  private async syncTags(
    workspaceId: string,
    projectId: string,
    tagNames: string[],
  ): Promise<void> {
    const db = getPgDb();
    await db
      .delete(projectTags)
      .where(and(eq(projectTags.workspaceId, workspaceId), eq(projectTags.projectId, projectId)));
    if (tagNames.length === 0) return;

    for (const name of tagNames) {
      const [existing] = await db
        .select()
        .from(tags)
        .where(and(eq(tags.workspaceId, workspaceId), eq(tags.name, name)))
        .limit(1);
      const tagId = existing?.id ?? createId("tag");
      if (!existing) {
        await db.insert(tags).values({ id: tagId, workspaceId, name });
      }
      await db
        .insert(projectTags)
        .values({ projectId, tagId, workspaceId })
        .onConflictDoNothing();
    }
  }

  /** How many events to keep, per workspace — see DrizzleProjectRepository's own note. */
  private static readonly ACTIVITY_RETENTION = 1000;
  private static readonly PRUNE_INTERVAL = 50;
  private writesSincePrune = 0;

  private async recordActivity(
    workspaceId: string,
    projectId: string | null,
    type: string,
    message: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const db = getPgDb();
    await db.insert(activityEvents).values({
      id: createId("act"),
      workspaceId,
      projectId,
      type,
      message,
      metadata,
    });

    this.writesSincePrune += 1;
    if (this.writesSincePrune < PostgresProjectRepository.PRUNE_INTERVAL) return;
    this.writesSincePrune = 0;

    // Delete everything in this workspace older than its newest
    // ACTIVITY_RETENTION rows — pruned per-workspace so one busy workspace
    // can't evict another's history.
    await db.execute(sql`
      delete from ${activityEvents}
      where ${activityEvents.workspaceId} = ${workspaceId}
      and ${activityEvents.createdAt} < (
        select ${activityEvents.createdAt} from ${activityEvents}
        where ${activityEvents.workspaceId} = ${workspaceId}
        order by ${activityEvents.createdAt} desc
        limit 1 offset ${PostgresProjectRepository.ACTIVITY_RETENTION}
      )
    `);
  }
}

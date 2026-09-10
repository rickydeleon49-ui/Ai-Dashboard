/**
 * The persistence contract for projects.
 *
 * Everything above this line (services, pages, components) depends only on this
 * interface — never on Drizzle or SQLite directly. Swapping SQLite for Postgres,
 * Turso or a hosted API later means writing one new implementation of this
 * interface and changing a single line in `./index.ts`.
 */
import type {
  Project,
  ProjectCreateInput,
  ProjectQuery,
  ProjectStats,
  ProjectUpdateInput,
} from "@/core/projects/types";

export interface TagCount {
  name: string;
  count: number;
}

/** The few fields the command palette needs to index a project. */
export interface ProjectSummary {
  id: string;
  name: string;
  source: string;
  status: string;
}

/**
 * The workspace id every SQLite-backed call site passes. Desktop and
 * today's single-password hosted mode are single-tenant forever — SQLite
 * never gained a `workspace_id` column (there is exactly one "workspace"
 * per install, and adding the column would be pure churn) — so this is the
 * one value `DrizzleProjectRepository` ever accepts; anything else is a
 * programming error, not a real multi-tenant boundary to enforce.
 */
export const LOCAL_WORKSPACE_ID = "local";

/**
 * `workspaceId` is a mandatory first parameter on every method, not ambient
 * request context — explicit and grep-able, matching this codebase's
 * no-DI style, and impossible to silently forget at a call site the way an
 * AsyncLocalStorage-based "current workspace" could be. `DrizzleProjectRepository`
 * (SQLite) only ever accepts `LOCAL_WORKSPACE_ID` and throws on anything
 * else; `PostgresProjectRepository` genuinely scopes every query to it.
 */
export interface ProjectRepository {
  list(workspaceId: string, query?: ProjectQuery): Promise<Project[]>;
  /**
   * Names and identifiers only, for the command palette.
   *
   * Kept separate from `list` because the palette is rebuilt on every page
   * navigation: it must not pay for tag joins or metadata parsing it discards.
   */
  listSummaries(workspaceId: string, limit?: number): Promise<ProjectSummary[]>;
  findById(workspaceId: string, id: string): Promise<Project | null>;
  findByExternalId(
    workspaceId: string,
    source: string,
    externalId: string,
  ): Promise<Project | null>;
  create(workspaceId: string, input: ProjectCreateInput): Promise<Project>;
  update(workspaceId: string, id: string, input: ProjectUpdateInput): Promise<Project | null>;
  delete(workspaceId: string, id: string): Promise<boolean>;
  /** Stamps `lastOpenedAt` and records an activity event. */
  markOpened(workspaceId: string, id: string): Promise<Project | null>;
  stats(workspaceId: string): Promise<ProjectStats>;
  allTags(workspaceId: string): Promise<TagCount[]>;
}

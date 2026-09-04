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

export interface ProjectRepository {
  list(query?: ProjectQuery): Promise<Project[]>;
  /**
   * Names and identifiers only, for the command palette.
   *
   * Kept separate from `list` because the palette is rebuilt on every page
   * navigation: it must not pay for tag joins or metadata parsing it discards.
   */
  listSummaries(limit?: number): Promise<ProjectSummary[]>;
  findById(id: string): Promise<Project | null>;
  findByExternalId(source: string, externalId: string): Promise<Project | null>;
  create(input: ProjectCreateInput): Promise<Project>;
  update(id: string, input: ProjectUpdateInput): Promise<Project | null>;
  delete(id: string): Promise<boolean>;
  /** Stamps `lastOpenedAt` and records an activity event. */
  markOpened(id: string): Promise<Project | null>;
  stats(): Promise<ProjectStats>;
  allTags(): Promise<TagCount[]>;
}

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

export interface ProjectRepository {
  list(query?: ProjectQuery): Promise<Project[]>;
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

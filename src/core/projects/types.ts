/**
 * Core project domain types.
 *
 * These are the single source of truth for what a "project" is anywhere in the
 * application — UI, API, database mapping and integrations all import from here.
 * Adding a field is a three-step change: add it here, add the column in
 * `src/db/schema.ts`, add it to the zod schema in `./schema.ts`.
 *
 * For anything experimental, prefer `metadata` over a new column: it is an
 * open-ended JSON bag that survives schema changes.
 */

/** Where a project came from. Drives which sections of the library it appears in. */
export const PROJECT_SOURCES = ["github", "uploaded", "manual"] as const;
export type ProjectSource = (typeof PROJECT_SOURCES)[number];

/** Lifecycle stage. Ordered from earliest to latest for sorting and progress UI. */
export const PROJECT_STATUSES = [
  "idea",
  "planning",
  "active",
  "paused",
  "completed",
  "archived",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** What kind of thing the project is. Extend freely — it is a plain string union. */
export const PROJECT_TYPES = [
  "software",
  "website",
  "ai",
  "automation",
  "script",
  "experiment",
  "work",
  "personal",
  "other",
] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export interface ProjectFile {
  id: string;
  projectId: string;
  filename: string;
  mimeType: string | null;
  /** Bytes. */
  size: number;
  /** Opaque key understood by the active storage driver (Phase 3). */
  storageKey: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  source: ProjectSource;
  type: ProjectType;
  status: ProjectStatus;
  tags: string[];

  repositoryUrl: string | null;
  projectUrl: string | null;
  localPath: string | null;
  notes: string | null;

  favorite: boolean;
  archived: boolean;

  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;

  /**
   * Identifier in the upstream system this project was imported from
   * (e.g. a GitHub repository id). Null for manually created projects.
   */
  externalId: string | null;
  /** When the upstream source was last pulled. */
  syncedAt: string | null;

  /** Open-ended extension point. Never required, always safe to ignore. */
  metadata: Record<string, unknown>;

  /** Hydrated on the detail page only. */
  files?: ProjectFile[];
}

/**
 * Fields a caller may set when creating a project.
 *
 * `createdAt`/`updatedAt` are settable so that importers (GitHub sync, archive
 * import, seeding) can preserve upstream timestamps instead of flattening every
 * imported project to "just now". They default to now when omitted.
 */
export type ProjectCreateInput = Partial<Omit<Project, "id" | "files">> & {
  name: string;
};

/** Fields a caller may change. Everything is optional. */
export type ProjectUpdateInput = Partial<
  Omit<Project, "id" | "createdAt" | "files">
>;

/** Query shape used by the unified project library. */
export interface ProjectQuery {
  search?: string;
  source?: ProjectSource | "all";
  status?: ProjectStatus | "all";
  type?: ProjectType | "all";
  tag?: string;
  favorite?: boolean;
  /** Archived projects are hidden unless this is explicitly true. */
  includeArchived?: boolean;
  sort?: ProjectSort;
  limit?: number;
}

export const PROJECT_SORTS = [
  "updated",
  "created",
  "opened",
  "name",
  "status",
] as const;
export type ProjectSort = (typeof PROJECT_SORTS)[number];

/**
 * Aggregate counts powering the dashboard overview and sidebar.
 *
 * `prompts` is not a project count, but the sidebar renders one badge per entry
 * from a single object, and threading a second source through every consumer to
 * avoid one field would cost more than it explains.
 */
export interface ProjectStats {
  total: number;
  active: number;
  github: number;
  uploaded: number;
  manual: number;
  favorites: number;
  archived: number;
  completed: number;
  prompts: number;
  byStatus: Record<ProjectStatus, number>;
}

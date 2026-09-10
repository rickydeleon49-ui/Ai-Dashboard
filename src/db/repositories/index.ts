import { DrizzleProjectRepository } from "./drizzle-project-repository";
import { PostgresProjectRepository } from "./postgres-project-repository";
import type { ProjectRepository } from "./project-repository";

/**
 * Composition root for persistence.
 *
 * This is the ONLY place that names a concrete implementation. Which one
 * depends on storage dialect alone (DATABASE_URL), independent of access
 * control mode (AUTH_MODE) — see docs/ARCHITECTURE.md. Every call site
 * still passes an explicit workspaceId; this only decides which backend
 * answers it. Desktop and today's single-password hosted mode never set
 * DATABASE_URL, so they always get the SQLite implementation.
 */
export const projectRepository: ProjectRepository = process.env.DATABASE_URL
  ? new PostgresProjectRepository()
  : new DrizzleProjectRepository();

export type { ProjectRepository } from "./project-repository";
export { LOCAL_WORKSPACE_ID } from "./project-repository";

import { DrizzleProjectRepository } from "./drizzle-project-repository";
import type { ProjectRepository } from "./project-repository";

/**
 * Composition root for persistence.
 *
 * This is the ONLY place that names a concrete implementation. Moving to
 * Postgres/Turso later is a one-line change here.
 */
export const projectRepository: ProjectRepository = new DrizzleProjectRepository();

export type { ProjectRepository } from "./project-repository";

import { DrizzleProjectRepository } from "./drizzle-project-repository";
import { PostgresProjectRepository } from "./postgres-project-repository";
import type { ProjectRepository } from "./project-repository";
import { DrizzleMilestoneRepository } from "./drizzle-milestone-repository";
import { PostgresMilestoneRepository } from "./postgres-milestone-repository";
import type { MilestoneRepository } from "./milestone-repository";
import { DrizzleTaskRepository } from "./drizzle-task-repository";
import { PostgresTaskRepository } from "./postgres-task-repository";
import type { TaskRepository } from "./task-repository";
import { DrizzleKnowledgeDocumentRepository } from "./drizzle-knowledge-document-repository";
import { PostgresKnowledgeDocumentRepository } from "./postgres-knowledge-document-repository";
import type { KnowledgeDocumentRepository } from "./knowledge-document-repository";

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

export const milestoneRepository: MilestoneRepository = process.env.DATABASE_URL
  ? new PostgresMilestoneRepository()
  : new DrizzleMilestoneRepository();

export const taskRepository: TaskRepository = process.env.DATABASE_URL
  ? new PostgresTaskRepository()
  : new DrizzleTaskRepository();

export const knowledgeDocumentRepository: KnowledgeDocumentRepository = process.env.DATABASE_URL
  ? new PostgresKnowledgeDocumentRepository()
  : new DrizzleKnowledgeDocumentRepository();

export type { ProjectRepository } from "./project-repository";
export type { MilestoneRepository } from "./milestone-repository";
export type { TaskRepository } from "./task-repository";
export type { KnowledgeDocumentRepository } from "./knowledge-document-repository";
export { LOCAL_WORKSPACE_ID } from "./project-repository";

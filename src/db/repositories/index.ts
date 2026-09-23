import { createRequire } from "node:module";
import { PostgresProjectRepository } from "./postgres-project-repository";
import type { ProjectRepository } from "./project-repository";
import { PostgresMilestoneRepository } from "./postgres-milestone-repository";
import type { MilestoneRepository } from "./milestone-repository";
import { PostgresTaskRepository } from "./postgres-task-repository";
import type { TaskRepository } from "./task-repository";
import { PostgresKnowledgeDocumentRepository } from "./postgres-knowledge-document-repository";
import type { KnowledgeDocumentRepository } from "./knowledge-document-repository";
import { PostgresChecklistRepository } from "./postgres-checklist-repository";
import type { ChecklistRepository } from "./checklist-repository";
import { PostgresCommentRepository } from "./postgres-comment-repository";
import type { CommentRepository } from "./comment-repository";
import { PostgresActivityRepository } from "./postgres-activity-repository";
import type { ActivityRepository } from "./activity-repository";
import { PostgresNotificationRepository } from "./postgres-notification-repository";
import type { NotificationRepository } from "./notification-repository";

const require = createRequire(import.meta.url);

/**
 * Composition root for persistence.
 *
 * This is the ONLY place that names a concrete implementation. Which one
 * depends on storage dialect alone (DATABASE_URL), independent of access
 * control mode (AUTH_MODE) — see docs/ARCHITECTURE.md. Every call site
 * still passes an explicit workspaceId; this only decides which backend
 * answers it. Desktop and today's single-password hosted mode never set
 * DATABASE_URL, so they always get the SQLite implementation.
 *
 * SQLite repositories are conditionally required only when DATABASE_URL is
 * absent, ensuring accounts/PostgreSQL mode never imports better-sqlite3 or client.ts.
 */
export const projectRepository: ProjectRepository = process.env.DATABASE_URL
  ? new PostgresProjectRepository()
  : new (require("./drizzle-project-repository").DrizzleProjectRepository)();

export const milestoneRepository: MilestoneRepository = process.env.DATABASE_URL
  ? new PostgresMilestoneRepository()
  : new (require("./drizzle-milestone-repository").DrizzleMilestoneRepository)();

export const taskRepository: TaskRepository = process.env.DATABASE_URL
  ? new PostgresTaskRepository()
  : new (require("./drizzle-task-repository").DrizzleTaskRepository)();

export const knowledgeDocumentRepository: KnowledgeDocumentRepository = process.env.DATABASE_URL
  ? new PostgresKnowledgeDocumentRepository()
  : new (require("./drizzle-knowledge-document-repository").DrizzleKnowledgeDocumentRepository)();

export const checklistRepository: ChecklistRepository = process.env.DATABASE_URL
  ? new PostgresChecklistRepository()
  : new (require("./drizzle-checklist-repository").DrizzleChecklistRepository)();

export const commentRepository: CommentRepository = process.env.DATABASE_URL
  ? new PostgresCommentRepository()
  : new (require("./drizzle-comment-repository").DrizzleCommentRepository)();

export const activityRepository: ActivityRepository = process.env.DATABASE_URL
  ? new PostgresActivityRepository()
  : new (require("./drizzle-activity-repository").DrizzleActivityRepository)();

/**
 * Collaboration notifications (Release 2C.6) exist only in PostgreSQL /
 * accounts mode — desktop deliberately has none, so there is no SQLite
 * implementation to choose. Constructing this touches no database; every
 * /api/inbox route refuses to run outside accounts mode before using it.
 */
export const notificationRepository: NotificationRepository = new PostgresNotificationRepository();

export type { ProjectRepository } from "./project-repository";
export type { MilestoneRepository } from "./milestone-repository";
export type { TaskRepository } from "./task-repository";
export type { KnowledgeDocumentRepository } from "./knowledge-document-repository";
export type { ChecklistRepository } from "./checklist-repository";
export type { CommentRepository } from "./comment-repository";
export type { ActivityRepository } from "./activity-repository";
export type { NotificationRepository } from "./notification-repository";
export { LOCAL_WORKSPACE_ID } from "./project-repository";

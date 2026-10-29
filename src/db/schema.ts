/**
 * Database schema (SQLite via Drizzle).
 *
 * Design notes:
 *  - Tags live in their own table with a join, so the library can filter and
 *    autocomplete on them without scanning JSON.
 *  - `metadata` columns are JSON-encoded text: the escape hatch for new fields
 *    that do not yet deserve a migration.
 *  - `github_repositories` deliberately mirrors the GitHub API rather than the
 *    Project model. Raw upstream data is cached there; a Project is only created
 *    when a repository is explicitly linked to the dashboard. That separation is
 *    what lets a resync update repo metadata without clobbering user edits.
 *  - `project_files`, `notes` and `prompts` exist from day one so that Phases 3
 *    and 4 are additive UI work, not a schema rewrite.
 */
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    source: text("source").notNull().default("manual"),
    type: text("type").notNull().default("software"),
    status: text("status").notNull().default("idea"),

    repositoryUrl: text("repository_url"),
    projectUrl: text("project_url"),
    localPath: text("local_path"),
    notes: text("notes"),

    favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),

    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
    lastOpenedAt: text("last_opened_at"),

    externalId: text("external_id"),
    syncedAt: text("synced_at"),

    metadata: text("metadata").notNull().default("{}"),
  },
  (t) => [
    index("projects_source_idx").on(t.source),
    index("projects_status_idx").on(t.status),
    index("projects_updated_idx").on(t.updatedAt),
    uniqueIndex("projects_source_external_idx").on(t.source, t.externalId),
  ],
);

export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    /** Always stored lowercase; the UI title-cases for display. */
    name: text("name").notNull(),
  },
  (t) => [uniqueIndex("tags_name_idx").on(t.name)],
);

export const projectTags = sqliteTable(
  "project_tags",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.tagId] }),
    index("project_tags_tag_idx").on(t.tagId),
  ],
);

/**
 * A goal within a project, grouping the tasks that complete it. Enum columns
 * (`status`) are plain text here, validated by Zod at the API layer, matching
 * how `projects.status` is already handled — not enforced by a CHECK
 * constraint the way some Postgres tables are (see schema.pg.ts's own note on
 * when a CHECK earns its keep).
 */
export const milestones = sqliteTable(
  "milestones",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    /** 'open' | 'completed' | 'cancelled' */
    status: text("status").notNull().default("open"),
    dueDate: text("due_date"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
    completedAt: text("completed_at"),
  },
  (t) => [
    index("milestones_project_idx").on(t.projectId),
    index("milestones_due_idx").on(t.dueDate),
  ],
);

/**
 * A unit of work within a project. `parentTaskId` self-references for
 * subtasks (one level is all the UI renders, but the schema doesn't stop a
 * deeper chain). `assigneeId` has no meaning on desktop — there is no user
 * concept there — so `DrizzleTaskRepository` always reads/writes it as
 * `null`; the column still exists so the SQLite and Postgres row shapes stay
 * parallel, matching every other table pair in this file.
 */
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    milestoneId: text("milestone_id").references(() => milestones.id, { onDelete: "set null" }),
    parentTaskId: text("parent_task_id").references((): AnySQLiteColumn => tasks.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    description: text("description"),
    /** 'todo' | 'in_progress' | 'done' | 'cancelled' */
    status: text("status").notNull().default("todo"),
    /** 'low' | 'medium' | 'high' | 'urgent' */
    priority: text("priority").notNull().default("medium"),
    /** Meaningless on desktop (single-tenant, no users) — always null there. */
    assigneeId: text("assignee_id"),
    dueDate: text("due_date"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
    completedAt: text("completed_at"),
  },
  (t) => [
    index("tasks_project_idx").on(t.projectId),
    index("tasks_milestone_idx").on(t.milestoneId),
    index("tasks_parent_idx").on(t.parentTaskId),
    index("tasks_due_idx").on(t.dueDate),
    index("tasks_status_idx").on(t.status),
  ],
);

/**
 * A "must complete before" edge between two tasks in the same project.
 * `taskId` is blocked until `dependsOnTaskId` reaches a done/cancelled
 * status — see `DrizzleTaskRepository`'s own note on how "blocked" is
 * computed (at read time, never stored) and how a cycle is rejected
 * before this table is ever written to.
 */
export const taskDependencies = sqliteTable(
  "task_dependencies",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    dependsOnTaskId: text("depends_on_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.dependsOnTaskId] }),
    index("task_dependencies_depends_on_idx").on(t.dependsOnTaskId),
  ],
);

/**
 * An item in a task checklist (Phase 2C, release C.3).
 * Dense 0-indexed position within a task.
 */
export const taskChecklistItems = sqliteTable(
  "task_checklist_item",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().default("default"),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    done: integer("done", { mode: "boolean" }).notNull().default(false),
    doneBy: text("done_by"),
    doneAt: text("done_at"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    index("task_checklist_item_task_pos_idx").on(t.taskId, t.position),
    index("task_checklist_item_workspace_task_idx").on(t.workspaceId, t.taskId),
  ],
);

/**
 * Comments on tasks (Phase 2C, release C.4).
 * Single-tenant desktop supported with soft-deletion.
 */
export const taskComments = sqliteTable(
  "task_comment",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().default("default"),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    authorId: text("author_id"),
    body: text("body").notNull(),
    deletedAt: text("deleted_at"),
    deletedBy: text("deleted_by"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    index("task_comment_task_created_idx").on(t.taskId, t.createdAt),
    index("task_comment_workspace_task_idx").on(t.workspaceId, t.taskId),
  ],
);

export const taskCommentEdits = sqliteTable(
  "task_comment_edit",
  {
    id: text("id").primaryKey(),
    commentId: text("comment_id")
      .notNull()
      .references(() => taskComments.id, { onDelete: "cascade" }),
    editedBy: text("edited_by"),
    previousBody: text("previous_body").notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    index("task_comment_edit_comment_idx").on(t.commentId, t.createdAt),
  ],
);

/**
 * Immutable activity events for tasks (Phase 2C, release C.4).
 * Tracks assignment, status, dependency, date, milestone, checklist, and comment changes.
 */
export const taskActivityEvents = sqliteTable(
  "task_activity_event",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().default("default"),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    actorId: text("actor_id"),
    type: text("type").notNull(),
    details: text("details").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    index("task_activity_event_task_idx").on(t.taskId, t.createdAt),
    index("task_activity_event_project_idx").on(t.projectId, t.createdAt),
    index("task_activity_event_workspace_idx").on(t.workspaceId, t.createdAt),
  ],
);


/**
 * A note in a project's knowledge base (Phase 2, release B) — flat, plain
 * text, no folders/hierarchy or version history in this first slice. See
 * `core/knowledge/types.ts` for the domain type this maps to.
 */
export const knowledgeDocuments = sqliteTable(
  "knowledge_documents",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content").notNull().default(""),
    category: text("category"),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
    /**
     * Derived (Release 2E.1): normalized title, category and visible document
     * text, from `buildKnowledgeSearchText`. Never shown; never the source.
     */
    searchText: text("search_text"),
    /**
     * The `updated_at` the search text was derived at. NULL or different
     * means stale — a pre-2E.1 row, or one written by an older build — and the
     * repository re-derives it before searching.
     */
    searchIndexedAt: text("search_indexed_at"),
  },
  (t) => [
    index("knowledge_documents_project_idx").on(t.projectId),
    index("knowledge_documents_category_idx").on(t.category),
  ],
);

/** Phase 3: uploaded ZIPs, documents, scripts and assets. */
export const projectFiles = sqliteTable(
  "project_files",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type"),
    size: integer("size").notNull().default(0),
    /** Opaque key resolved by the active storage driver. */
    storageKey: text("storage_key").notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("project_files_project_idx").on(t.projectId)],
);

/** Append-only feed powering "Recent activity". */
export const activityEvents = sqliteTable(
  "activity_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    /** e.g. project.created, project.opened, github.synced */
    type: text("type").notNull(),
    message: text("message").notNull(),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("activity_created_idx").on(t.createdAt)],
);

/**
 * Cached GitHub repository metadata. Mirrors the API payload, not the Project
 * model, so that syncing is a pure upstream refresh.
 */
export const githubRepositories = sqliteTable(
  "github_repositories",
  {
    id: text("id").primaryKey(),
    /** GitHub's numeric repository id, as a string. */
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    fullName: text("full_name").notNull(),
    owner: text("owner").notNull(),
    description: text("description"),
    language: text("language"),
    stars: integer("stars").notNull().default(0),
    forks: integer("forks").notNull().default(0),
    openIssues: integer("open_issues").notNull().default(0),
    isPrivate: integer("is_private", { mode: "boolean" }).notNull().default(false),
    isArchived: integer("is_archived", { mode: "boolean" }).notNull().default(false),
    isFork: integer("is_fork", { mode: "boolean" }).notNull().default(false),
    defaultBranch: text("default_branch").notNull().default("main"),
    htmlUrl: text("html_url").notNull(),
    homepage: text("homepage"),
    topics: text("topics").notNull().default("[]"),
    pushedAt: text("pushed_at"),
    updatedAt: text("updated_at"),
    syncedAt: text("synced_at").notNull().default(now),
    /** Set when the repository has been added to the dashboard as a project. */
    linkedProjectId: text("linked_project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    /**
     * True for sample rows written by the demo provider.
     *
     * Demo and real repositories share this table, so without a flag there is
     * no way to tell them apart after the fact — and a sync that cannot tell
     * them apart is a sync that can delete real cached repositories when a
     * token stops working. Cleanup uses this to only ever remove its own kind.
     */
    isDemo: integer("is_demo", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [uniqueIndex("github_repos_external_idx").on(t.externalId)],
);

/** Standalone notes (the Notes section). Project notes live on the project row. */
export const notes = sqliteTable(
  "notes",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [index("notes_updated_idx").on(t.updatedAt)],
);

/** Phase 4: the prompt library. Table exists now so the UI can land later. */
export const prompts = sqliteTable("prompts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  model: text("model"),
  category: text("category"),
  favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
});

/**
 * Local AI conversations.
 *
 * Separate from `prompts` (a library of reusable text) and from `notes` (things
 * you wrote): a conversation is an ordered transcript with a model and a
 * project attached, and forcing it into either of those would lose the ordering
 * that makes it replayable.
 *
 * The project reference is nullable and clears rather than cascades — deleting
 * a project should not silently destroy the thinking you did about it.
 */
export const aiConversations = sqliteTable(
  "ai_conversations",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull().default("New chat"),
    /** Which provider answered: local | hermes. */
    provider: text("provider").notNull().default("local"),
    /** chat | agent */
    mode: text("mode").notNull().default("chat"),
    /** Model tag last used in this conversation. */
    model: text("model"),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [index("ai_conversations_updated_idx").on(t.updatedAt)],
);

export const aiMessages = sqliteTable(
  "ai_messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),
    /** system | user | assistant */
    role: text("role").notNull(),
    content: text("content").notNull().default(""),
    model: text("model"),
    /** Set when generation was stopped or failed part-way. */
    stoppedReason: text("stopped_reason"),
    /**
     * Files the user attached to this turn, as a JSON array of
     * `{ id, filename, size, truncated }`.
     *
     * A summary, not the bytes: the transcript records *what* was sent so the
     * conversation still reads correctly on reload, while the contents stay in
     * the uploads directory where they can be re-read, re-sent or deleted.
     */
    attachments: text("attachments"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    durationMs: integer("duration_ms"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("ai_messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

/** Simple key/value store for integration state and user preferences. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(now),
});

/**
 * Scheduled work the application performs for you.
 *
 * There is no always-on server behind a desktop app, so these run while it is
 * open and catch up on launch. `intervalMinutes` is therefore a "no more often
 * than" rather than a guarantee, and `lastRunAt` is what makes catch-up
 * possible: on start, anything overdue runs once.
 */
export const automations = sqliteTable(
  "automations",
  {
    id: text("id").primaryKey(),
    /** Which registered task this runs, e.g. github.sync */
    type: text("type").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    intervalMinutes: integer("interval_minutes").notNull().default(60),
    /** Task-specific options, shape owned by the task definition. */
    config: text("config").notNull().default("{}"),
    lastRunAt: text("last_run_at"),
    /** ok | failed | skipped */
    lastStatus: text("last_status"),
    lastMessage: text("last_message"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("automations_type_idx").on(t.type)],
);

/**
 * Things worth telling you about, produced by automations.
 *
 * Separate from activity_events: activity is a log of what happened, this is a
 * short list of what you have not seen yet. Conflating them would mean either
 * marking ordinary history as read or losing the unread notion entirely.
 */
export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    body: text("body"),
    /** info | success | warning */
    level: text("level").notNull().default("info"),
    /** Optional in-app destination, e.g. /projects/abc */
    href: text("href"),
    source: text("source"),
    readAt: text("read_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("notifications_created_idx").on(t.createdAt)],
);

export type AutomationRow = typeof automations.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;

export type ProjectRow = typeof projects.$inferSelect;
export type MilestoneRow = typeof milestones.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskDependencyRow = typeof taskDependencies.$inferSelect;
export type TaskChecklistItemRow = typeof taskChecklistItems.$inferSelect;
export type KnowledgeDocumentRow = typeof knowledgeDocuments.$inferSelect;
export type GithubRepositoryRow = typeof githubRepositories.$inferSelect;
export type ActivityRow = typeof activityEvents.$inferSelect;
export type NoteRow = typeof notes.$inferSelect;
export type AiConversationRow = typeof aiConversations.$inferSelect;
export type AiMessageRow = typeof aiMessages.$inferSelect;
export type TaskCommentRow = typeof taskComments.$inferSelect;
export type TaskCommentEditRow = typeof taskCommentEdits.$inferSelect;
export type TaskActivityEventRow = typeof taskActivityEvents.$inferSelect;

/**
 * Release 2D.3 reusable templates (docs/design/2D.3-reusable-templates.md §2).
 * Desktop templates are personal to the installation: no workspace or user
 * columns. Template-owned (CASCADE); items refer to each other by
 * template-local `key`s through composite foreign keys.
 */
export const projectTemplates = sqliteTable(
  "project_templates",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    projectName: text("project_name").notNull(),
    projectDescription: text("project_description"),
    projectType: text("project_type").notNull().default("software"),
    projectStatus: text("project_status").notNull().default("idea"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [index("project_templates_name_idx").on(t.name)],
);

export const projectTemplateMilestones = sqliteTable(
  "project_template_milestones",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id")
      .notNull()
      .references(() => projectTemplates.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    targetOffset: integer("target_offset"),
  },
  (t) => [uniqueIndex("project_template_milestones_key_uq").on(t.templateId, t.key)],
);

export const projectTemplateTasks = sqliteTable(
  "project_template_tasks",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id")
      .notNull()
      .references(() => projectTemplates.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    priority: text("priority").notNull().default("medium"),
    dueOffset: integer("due_offset"),
    milestoneKey: text("milestone_key"),
    parentKey: text("parent_key"),
  },
  (t) => [
    uniqueIndex("project_template_tasks_key_uq").on(t.templateId, t.key),
    foreignKey({
      columns: [t.templateId, t.milestoneKey],
      foreignColumns: [projectTemplateMilestones.templateId, projectTemplateMilestones.key],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.templateId, t.parentKey],
      foreignColumns: [t.templateId, t.key],
    }).onDelete("cascade"),
  ],
);

export const projectTemplateDependencies = sqliteTable(
  "project_template_dependencies",
  {
    templateId: text("template_id")
      .notNull()
      .references(() => projectTemplates.id, { onDelete: "cascade" }),
    taskKey: text("task_key").notNull(),
    dependsOnKey: text("depends_on_key").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.templateId, t.taskKey, t.dependsOnKey] }),
    foreignKey({
      columns: [t.templateId, t.taskKey],
      foreignColumns: [projectTemplateTasks.templateId, projectTemplateTasks.key],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.templateId, t.dependsOnKey],
      foreignColumns: [projectTemplateTasks.templateId, projectTemplateTasks.key],
    }).onDelete("cascade"),
  ],
);

export const projectTemplateChecklistItems = sqliteTable(
  "project_template_checklist_items",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id")
      .notNull()
      .references(() => projectTemplates.id, { onDelete: "cascade" }),
    taskKey: text("task_key").notNull(),
    position: integer("position").notNull(),
    text: text("text").notNull(),
  },
  (t) => [
    uniqueIndex("project_template_checklist_items_pos_uq").on(t.templateId, t.taskKey, t.position),
    foreignKey({
      columns: [t.templateId, t.taskKey],
      foreignColumns: [projectTemplateTasks.templateId, projectTemplateTasks.key],
    }).onDelete("cascade"),
  ],
);

export const projectTemplateDocuments = sqliteTable(
  "project_template_documents",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id")
      .notNull()
      .references(() => projectTemplates.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull().default(""),
    category: text("category"),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [uniqueIndex("project_template_documents_pos_uq").on(t.templateId, t.position)],
);

/** One row per template application — the idempotency claim (actor "local"). */
export const projectTemplateApplications = sqliteTable(
  "project_template_applications",
  {
    id: text("id").primaryKey(),
    actorKey: text("actor_key").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    templateId: text("template_id").references(() => projectTemplates.id, { onDelete: "set null" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("project_template_applications_key_uq").on(t.actorKey, t.idempotencyKey)],
);

export type ProjectTemplateRow = typeof projectTemplates.$inferSelect;

/**
 * Agent Workflow Control Center tables (Release AW.1, §2.2, §4).
 * Desktop-only: agent orchestration runs strictly in local desktop mode,
 * never in hosted or accounts mode (where agent routes return 404).
 * SQLite only — these tables have no Postgres counterpart in schema.pg.ts.
 */
export const agentProjectPolicies = sqliteTable(
  "agent_project_policy",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    checkCommands: text("check_commands").notNull().default("[]"),
    excludedPaths: text("excluded_paths").notNull().default("[]"),
    testRestrictions: text("test_restrictions").notNull().default("[]"),
    defaults: text("defaults").notNull().default("{}"),
    roadmapSource: text("roadmap_source"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
);
export const agentProjectPolicy = agentProjectPolicies;

export const agentRuns = sqliteTable(
  "agent_run",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    stage: text("stage"),
    request: text("request").notNull().default("{}"),
    workspaceKind: text("workspace_kind"),
    workspacePath: text("workspace_path"), // null until the workspace is prepared
    baseRef: text("base_ref"),
    branch: text("branch"),
    correctionRound: integer("correction_round").notNull().default(0),
    outcome: text("outcome"),
    runnerEpoch: text("runner_epoch"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
    endedAt: text("ended_at"),
  },
  (t) => [
    index("agent_run_project_created_idx").on(t.projectId, t.createdAt),
    index("agent_run_status_idx").on(t.status),
  ],
);
export const agentRun = agentRuns;

export const agentRunEvents = sqliteTable(
  "agent_run_event",
  {
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    ts: text("ts").notNull().default(now),
    stage: text("stage"),
    agent: text("agent").notNull(),
    kind: text("kind").notNull(),
    payload: text("payload").notNull().default("{}"),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.seq] }),
  ],
);
export const agentRunEvent = agentRunEvents;

export const agentRunIntents = sqliteTable(
  "agent_run_intent",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payload: text("payload").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(now),
    claimedAt: text("claimed_at"),
  },
  (t) => [
    index("agent_run_intent_queue_idx").on(t.claimedAt, t.createdAt),
  ],
);
export const agentRunIntent = agentRunIntents;

export const agentWorkspaceLocks = sqliteTable(
  "agent_workspace_lock",
  {
    lockKey: text("lock_key").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().default(now),
  },
);
export const agentWorkspaceLock = agentWorkspaceLocks;

export type AgentProjectPolicyRow = typeof agentProjectPolicies.$inferSelect;
export type AgentRunRow = typeof agentRuns.$inferSelect;
export type AgentRunEventRow = typeof agentRunEvents.$inferSelect;
export type AgentRunIntentRow = typeof agentRunIntents.$inferSelect;
export type AgentWorkspaceLockRow = typeof agentWorkspaceLocks.$inferSelect;

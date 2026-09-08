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
export type GithubRepositoryRow = typeof githubRepositories.$inferSelect;
export type ActivityRow = typeof activityEvents.$inferSelect;
export type NoteRow = typeof notes.$inferSelect;
export type AiConversationRow = typeof aiConversations.$inferSelect;
export type AiMessageRow = typeof aiMessages.$inferSelect;

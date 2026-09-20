/**
 * Database schema (PostgreSQL via Drizzle) — hosted multi-user mode only.
 *
 * Separate from `schema.ts` (SQLite) deliberately: Drizzle's `sqlite-core` and
 * `pg-core` table builders are not interchangeable, so there is no way to share
 * table definitions between the two dialects. Desktop and today's single-
 * password hosted mode never read this file or connect to Postgres at all —
 * this schema only exists once `DATABASE_URL` is configured.
 */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

/**
 * Auth.js's required tables, in the exact shape `@auth/drizzle-adapter`'s
 * Postgres adapter expects (its own default schema is not exported as an
 * importable subpath, so this mirrors it rather than reimplementing the
 * adapter's logic — matching its column names/types is what matters, not
 * matching its file layout).
 */
export const users = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),
});

export const accounts = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({ columns: [account.provider, account.providerAccountId] }),
  ],
);

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (verificationToken) => [
    primaryKey({
      columns: [verificationToken.identifier, verificationToken.token],
    }),
  ],
);

/**
 * The workspace domain: personal and team workspaces, membership and roles,
 * pending invitations. Nothing outside hosted multi-user mode reads these —
 * desktop stays account-free and single-tenant forever.
 */

export const workspaces = pgTable(
  "workspace",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    /** 'personal' | 'team' */
    kind: text("kind").notNull(),
    createdBy: text("created_by")
      .references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    check("workspace_kind_check", sql`${t.kind} in ('personal', 'team')`),
    // Exactly one personal workspace per user. Also what makes the
    // create-personal-workspace self-heal (see core/workspaces/service.ts)
    // safe under a race: a second concurrent attempt just hits this and
    // fails, rather than creating a duplicate.
    uniqueIndex("workspace_personal_owner_idx")
      .on(t.createdBy)
      .where(sql`${t.kind} = 'personal' and ${t.createdBy} is not null`),
  ],
);

export const workspaceMembers = pgTable(
  "workspace_member",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 'owner' | 'admin' | 'member' | 'viewer' */
    role: text("role").notNull(),
    /** 'active' | 'invited' | 'suspended' | 'removed' */
    status: text("status").notNull().default("active"),
    invitedBy: text("invited_by").references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    // "Which workspaces does this user belong to" is the other direction
    // every membership lookup needs, beyond the primary key's own order.
    index("workspace_member_user_idx").on(t.userId),
    check(
      "workspace_member_role_check",
      sql`${t.role} in ('owner', 'admin', 'member', 'viewer')`,
    ),
    check(
      "workspace_member_status_check",
      sql`${t.status} in ('active', 'invited', 'suspended', 'removed')`,
    ),
  ],
);

export const workspaceInvitations = pgTable(
  "workspace_invitation",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Invited by address; the invitee may not have an account yet. */
    email: text("email").notNull(),
    /** 'admin' | 'member' | 'viewer' — never 'owner'. An invite cannot mint
     * an owner; ownership transfer is a separate action between an existing
     * owner and an existing member. */
    role: text("role").notNull(),
    /** sha-256 of the raw token. The raw token is never persisted. */
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: text("invited_by")
      .references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    revokedAt: timestamp("revoked_at", { mode: "date" }),
    acceptedAt: timestamp("accepted_at", { mode: "date" }),
    acceptedBy: text("accepted_by").references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("workspace_invitation_workspace_idx").on(t.workspaceId),
    check(
      "workspace_invitation_role_check",
      sql`${t.role} in ('admin', 'member', 'viewer')`,
    ),
    // At most one live (pending) invite per (workspace, email) — re-inviting
    // the same address just means there is already one outstanding.
    uniqueIndex("workspace_invitation_pending_idx")
      .on(t.workspaceId, sql`lower(${t.email})`)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
  ],
);

/**
 * The project domain, workspace-scoped — hosted multi-user mode's own
 * projects/tags/project_tags/activity_events, entirely separate from
 * SQLite's unscoped tables of the same name (see schema.ts). Column
 * shapes mirror the SQLite versions closely so PostgresProjectRepository's
 * domain mapping matches DrizzleProjectRepository's, but use native
 * Postgres types (boolean, jsonb, timestamp) rather than SQLite's
 * integer/text encodings of the same — a PostgresProjectRepository detail,
 * not something the shared `Project` domain type needs to know about.
 *
 * No CHECK constraints on source/type/status: matches how the SQLite table
 * already treats them (plain text, validated by the Zod schema in the API
 * layer, not the database) — this table is new, but there is no reason for
 * its enforcement posture to differ from its SQLite counterpart.
 */
export const projects = pgTable(
  "project",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    source: text("source").notNull().default("manual"),
    type: text("type").notNull().default("software"),
    status: text("status").notNull().default("idea"),

    repositoryUrl: text("repository_url"),
    projectUrl: text("project_url"),
    localPath: text("local_path"),
    notes: text("notes"),

    favorite: boolean("favorite").notNull().default(false),
    archived: boolean("archived").notNull().default(false),

    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
    lastOpenedAt: timestamp("last_opened_at", { mode: "date" }),

    externalId: text("external_id"),
    syncedAt: timestamp("synced_at", { mode: "date" }),

    metadata: jsonb("metadata").notNull().default({}),
  },
  (t) => [
    index("project_workspace_idx").on(t.workspaceId),
    // Used by findByExternalId, scoped the same way every other lookup is.
    index("project_workspace_external_idx").on(t.workspaceId, t.source, t.externalId),
  ],
);

export const tags = pgTable(
  "tag",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Always stored lowercase; the UI title-cases for display. */
    name: text("name").notNull(),
  },
  (t) => [
    // Unlike SQLite's globally-unique tag name, two workspaces may each
    // have their own "python" tag independently.
    uniqueIndex("tag_workspace_name_idx").on(t.workspaceId, t.name),
  ],
);

export const projectTags = pgTable(
  "project_tag",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    // Denormalized from project/tag (both already belong to the same
    // workspace by construction) so a join mistake elsewhere can't
    // associate a tag from one workspace with a project in another —
    // every query can filter on this column directly rather than trusting
    // a join to have scoped things correctly.
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.tagId] }),
    index("project_tag_tag_idx").on(t.tagId),
    index("project_tag_workspace_idx").on(t.workspaceId),
  ],
);

/**
 * The ownership-claim flow's own durable "already done" record — a single
 * row, always at id "singleton". A pre-accounts-mode hosted install has its
 * data in SQLite with no owner at all; this table is what lets exactly one
 * signed-in account claim it (importing the legacy SQLite projects/tags
 * into their own workspace) and makes sure no later visitor can repeat
 * that. The row is inserted with `onConflictDoNothing()` racing on the
 * primary key itself, so a second concurrent claim attempt loses outright
 * rather than needing a separate lock.
 */
export const OWNERSHIP_CLAIM_STATUSES = [
  "pending",
  "running",
  "partially_completed",
  "completed",
  "failed",
] as const;
export type OwnershipClaimStatus = (typeof OWNERSHIP_CLAIM_STATUSES)[number];

export const ownershipClaims = pgTable(
  "ownership_claim",
  {
    id: text("id").primaryKey(),
    claimedBy: text("claimed_by")
      .notNull()
      .references(() => users.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    projectsImported: integer("projects_imported").notNull().default(0),
    importedProjectIds: jsonb("imported_project_ids")
      .notNull()
      .$type<string[]>()
      .default([]),
    lastError: text("last_error"),
    claimedAt: timestamp("claimed_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "ownership_claim_status_check",
      sql`${t.status} in ('pending', 'running', 'partially_completed', 'completed', 'failed')`,
    ),
  ],
);

export const activityEvents = pgTable(
  "activity_event",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    /** e.g. project.created, project.opened, github.synced */
    type: text("type").notNull(),
    message: text("message").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("activity_event_workspace_created_idx").on(t.workspaceId, t.createdAt)],
);

/**
 * The planning domain (Phase 2, release A) — a goal within a project,
 * grouping the tasks that complete it. Workspace-scoped from day one, unlike
 * SQLite's version of this table, which has no workspace_id column at all
 * (single-tenant forever — see LOCAL_WORKSPACE_ID's own comment in
 * db/repositories/project-repository.ts). `status` gets a CHECK constraint
 * here (a small closed set with real integrity implications), matching
 * workspace_member.role rather than projects.status — see that table's own
 * comment for when this codebase does and doesn't bother with one.
 */
export const milestones = pgTable(
  "milestone",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("open"),
    dueDate: timestamp("due_date", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { mode: "date" }),
  },
  (t) => [
    index("milestone_project_idx").on(t.projectId),
    index("milestone_workspace_due_idx").on(t.workspaceId, t.dueDate),
    check("milestone_status_check", sql`${t.status} in ('open', 'completed', 'cancelled')`),
  ],
);

/**
 * A unit of work within a project. `parentTaskId` self-references for
 * subtasks; `assigneeId` references a real user here (unlike SQLite, which
 * has no user concept and always leaves this null — see schema.ts's own
 * comment on the same column). Losing the assignee (removed from the
 * workspace, or the account itself gone) clears the field rather than
 * blocking the deletion or orphaning a reference — a task should never be
 * unremovable because of who it happened to be assigned to.
 */
export const tasks = pgTable(
  "task",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    milestoneId: text("milestone_id").references(() => milestones.id, { onDelete: "set null" }),
    parentTaskId: text("parent_task_id").references((): AnyPgColumn => tasks.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("todo"),
    priority: text("priority").notNull().default("medium"),
    assigneeId: text("assignee_id").references(() => users.id, { onDelete: "set null" }),
    assignedBy: text("assigned_by").references(() => users.id, { onDelete: "set null" }),
    assignedAt: timestamp("assigned_at", { mode: "date" }),
    dueDate: timestamp("due_date", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { mode: "date" }),
  },
  (t) => [
    index("task_project_idx").on(t.projectId),
    index("task_milestone_idx").on(t.milestoneId),
    index("task_parent_idx").on(t.parentTaskId),
    index("task_workspace_assignee_idx").on(t.workspaceId, t.assigneeId),
    index("task_workspace_assigned_by_idx").on(t.workspaceId, t.assignedBy),
    index("task_workspace_due_idx").on(t.workspaceId, t.dueDate),
    check(
      "task_status_check",
      sql`${t.status} in ('todo', 'in_progress', 'done', 'cancelled')`,
    ),
    check(
      "task_priority_check",
      sql`${t.priority} in ('low', 'medium', 'high', 'urgent')`,
    ),
  ],
);

/**
 * A "must complete before" edge between two tasks. `taskId` is blocked
 * until `dependsOnTaskId` reaches a done/cancelled status — see
 * `PostgresTaskRepository`'s own note on how "blocked" is computed (at
 * read time, never stored) and how a cycle is rejected before this table
 * is ever written to. `workspaceId` is denormalized the same way
 * `project_tag.workspaceId` is — both tasks already belong to the same
 * workspace by construction, but every query can filter on this column
 * directly rather than trusting a join to have scoped things correctly.
 */
export const taskDependencies = pgTable(
  "task_dependency",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    dependsOnTaskId: text("depends_on_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.dependsOnTaskId] }),
    index("task_dependency_depends_on_idx").on(t.dependsOnTaskId),
    index("task_dependency_workspace_idx").on(t.workspaceId),
    check("task_dependency_no_self_check", sql`${t.taskId} != ${t.dependsOnTaskId}`),
  ],
);

/**
 * A note in a project's knowledge base (Phase 2, release B). Workspace-scoped
 * from day one, unlike SQLite's version of this table — see
 * `knowledgeDocuments` in `schema.ts` and `core/knowledge/types.ts` for the
 * domain type both map to. Flat, plain text, no folders/hierarchy or version
 * history in this first slice.
 */
export const knowledgeDocuments = pgTable(
  "knowledge_document",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content").notNull().default(""),
    category: text("category"),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("knowledge_document_project_idx").on(t.projectId),
    index("knowledge_document_workspace_category_idx").on(t.workspaceId, t.category),
  ],
);

/**
 * An item in a task checklist (Phase 2C, release C.3).
 * Dense 0-indexed position within a task, with workspace scoping and attribution.
 */
export const taskChecklistItems = pgTable(
  "task_checklist_item",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    done: boolean("done").notNull().default(false),
    doneBy: text("done_by").references(() => users.id, { onDelete: "set null" }),
    doneAt: timestamp("done_at", { mode: "date" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("task_checklist_item_task_pos_idx").on(t.taskId, t.position),
    index("task_checklist_item_workspace_task_idx").on(t.workspaceId, t.taskId),
  ],
);

export type TaskChecklistItemRow = typeof taskChecklistItems.$inferSelect;

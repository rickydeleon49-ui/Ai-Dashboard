import "server-only";

/**
 * PostgreSQL implementation of NotificationRepository (Release 2C.6), plus the
 * in-transaction writer the task and comment repositories call to generate
 * notifications. See docs/design/2C.6-collaboration-notifications.md.
 */
import { and, count, desc, eq, inArray, isNull, isNotNull, sql, type SQL } from "drizzle-orm";
import { getPgDb } from "../pg-client";
import {
  notificationPreferences,
  notifications,
  projects,
  taskComments,
  tasks,
  users,
  workspaceMembers,
} from "../schema.pg";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_CATEGORIES,
  type CollaborationNotification,
  type NotificationCategory,
  type NotificationDraft,
  type NotificationListQuery,
  type NotificationPreferences,
  type NotificationPreferencesUpdate,
  type NotificationStateChange,
  type PaginatedNotifications,
} from "@/core/notifications/types";
import { decodeNotificationCursor, encodeNotificationCursor } from "@/core/notifications/cursor";
import { sanitizeNotificationDetails } from "@/core/notifications/details";
import { UUID_REGEX } from "@/core/tasks/mention-utils";
import type { NotificationRepository } from "./notification-repository";
import type { PgExecutor } from "./postgres-task-repository";

/**
 * Database-clock write time, millisecond precision, UTC — the same rule as
 * task_comment (2C.4): one clock across instances, and exact round trips
 * through a JavaScript Date for the pagination cursor.
 */
const DB_NOW_MS = sql`date_trunc('milliseconds', statement_timestamp() AT TIME ZONE 'UTC')`;

/**
 * Inserts the notifications described by `drafts` using `executor` — always
 * the caller's own transaction, so a notification exists if and only if the
 * change that caused it committed (design note §6.1).
 *
 * One INSERT … SELECT per draft. The SELECT re-derives every recipient from
 * workspace_member, so only ACTIVE members of the draft's own workspace can
 * receive a row, whatever recipient ids were passed; the actor is never a
 * recipient; a recipient's disabled preference for the category excludes
 * them; and ON CONFLICT on (recipient_id, source_event_id) makes processing
 * the same event twice a no-op. Returns the number of rows inserted.
 */
export async function insertNotificationDrafts(
  executor: PgExecutor,
  drafts: readonly NotificationDraft[],
): Promise<number> {
  let inserted = 0;
  for (const draft of drafts) {
    const recipientIds = Array.from(new Set(draft.recipientIds.filter((id) => typeof id === "string" && id)));
    if (recipientIds.length === 0) continue;
    if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(draft.category)) {
      throw new Error(`Unknown notification category: ${draft.category}`);
    }
    const details = JSON.stringify(sanitizeNotificationDetails(draft.category, draft.details));
    const result = await executor.execute(sql`
      insert into ${notifications} (
        "id", "workspace_id", "recipient_id", "actor_id", "category", "source_event_id",
        "task_id", "project_id", "comment_id", "details", "created_at"
      )
      select
        gen_random_uuid()::text, wm."workspace_id", wm."user_id", ${draft.actorId}, ${draft.category},
        ${draft.sourceEventId}, ${draft.taskId}, ${draft.projectId}, ${draft.commentId ?? null},
        ${details}::jsonb, ${DB_NOW_MS}
      from ${workspaceMembers} wm
      where wm."workspace_id" = ${draft.workspaceId}
        and wm."status" = 'active'
        and wm."user_id" in (${sql.join(recipientIds.map((id) => sql`${id}`), sql`, `)})
        and wm."user_id" is distinct from ${draft.actorId}
        and not exists (
          select 1 from ${notificationPreferences} p
          where p."workspace_id" = wm."workspace_id"
            and p."user_id" = wm."user_id"
            and p."category" = ${draft.category}
            and p."enabled" = false
        )
      on conflict ("recipient_id", "source_event_id") do nothing
    `);
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

const selection = {
  id: notifications.id,
  category: notifications.category,
  actorId: notifications.actorId,
  details: notifications.details,
  readAt: notifications.readAt,
  archivedAt: notifications.archivedAt,
  createdAt: notifications.createdAt,
  commentId: notifications.commentId,
  taskId: tasks.id,
  taskTitle: tasks.title,
  taskProjectId: tasks.projectId,
  projectId: projects.id,
  projectName: projects.name,
  liveCommentId: taskComments.id,
  commentDeletedAt: taskComments.deletedAt,
  actorMemberId: workspaceMembers.userId,
  actorName: users.name,
};

/**
 * The one read shape. Every join is additionally scoped to the notification's
 * own workspace, so a notification can never render another workspace's task,
 * project, comment or member — even for a corrupted row.
 */
function selectNotifications(where: SQL | undefined) {
  return getPgDb()
    .select(selection)
    .from(notifications)
    .leftJoin(
      tasks,
      and(eq(tasks.id, notifications.taskId), eq(tasks.workspaceId, notifications.workspaceId)),
    )
    .leftJoin(
      projects,
      and(
        eq(projects.workspaceId, notifications.workspaceId),
        sql`${projects.id} = coalesce(${tasks.projectId}, ${notifications.projectId})`,
      ),
    )
    .leftJoin(
      taskComments,
      and(
        eq(taskComments.id, notifications.commentId),
        eq(taskComments.workspaceId, notifications.workspaceId),
      ),
    )
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, notifications.workspaceId),
        eq(workspaceMembers.userId, notifications.actorId),
      ),
    )
    .leftJoin(users, eq(users.id, workspaceMembers.userId))
    .where(where);
}

type SelectedRow = Awaited<ReturnType<typeof selectNotifications>>[number];

export class PostgresNotificationRepository implements NotificationRepository {
  async list(
    workspaceId: string,
    recipientId: string,
    query: NotificationListQuery,
  ): Promise<PaginatedNotifications> {
    const conditions: SQL[] = [
      eq(notifications.workspaceId, workspaceId),
      eq(notifications.recipientId, recipientId),
      query.view === "archived" ? isNotNull(notifications.archivedAt) : isNull(notifications.archivedAt),
    ];
    if (query.filter === "unread") conditions.push(isNull(notifications.readAt));
    if (query.cursor !== undefined) {
      const cursor = decodeNotificationCursor(query.cursor);
      conditions.push(
        sql`(${notifications.createdAt}, ${notifications.id}) < (${cursor.createdAt}::timestamp, ${cursor.id})`,
      );
    }

    const rows = await selectNotifications(and(...conditions))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];
    return {
      notifications: page.map(toDomain),
      nextCursor:
        hasMore && last
          ? encodeNotificationCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }

  async findById(
    workspaceId: string,
    recipientId: string,
    id: string,
  ): Promise<CollaborationNotification | null> {
    if (!UUID_REGEX.test(id)) return null;
    const [row] = await selectNotifications(
      and(
        eq(notifications.id, id),
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.recipientId, recipientId),
      ),
    ).limit(1);
    return row ? toDomain(row) : null;
  }

  async unreadCount(workspaceId: string, recipientId: string): Promise<number> {
    const [row] = await getPgDb()
      .select({ value: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.workspaceId, workspaceId),
          eq(notifications.recipientId, recipientId),
          isNull(notifications.readAt),
          isNull(notifications.archivedAt),
        ),
      );
    return Number(row?.value ?? 0);
  }

  async updateState(
    workspaceId: string,
    recipientId: string,
    id: string,
    change: NotificationStateChange,
  ): Promise<CollaborationNotification | null> {
    if (!UUID_REGEX.test(id)) return null;
    const set: { readAt?: SQL | null; archivedAt?: SQL | null } = {};
    if (change.read !== undefined) {
      set.readAt = change.read ? sql`coalesce(${notifications.readAt}, ${DB_NOW_MS})` : null;
    }
    if (change.archived !== undefined) {
      set.archivedAt = change.archived ? sql`coalesce(${notifications.archivedAt}, ${DB_NOW_MS})` : null;
    }
    if (set.readAt === undefined && set.archivedAt === undefined) {
      return this.findById(workspaceId, recipientId, id);
    }

    const updated = await getPgDb()
      .update(notifications)
      .set(set)
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.workspaceId, workspaceId),
          eq(notifications.recipientId, recipientId),
        ),
      )
      .returning({ id: notifications.id });
    if (updated.length === 0) return null;
    return this.findById(workspaceId, recipientId, id);
  }

  async markAllRead(workspaceId: string, recipientId: string): Promise<number> {
    const result = await getPgDb()
      .update(notifications)
      .set({ readAt: DB_NOW_MS })
      .where(
        and(
          eq(notifications.workspaceId, workspaceId),
          eq(notifications.recipientId, recipientId),
          isNull(notifications.readAt),
        ),
      );
    return result.rowCount ?? 0;
  }

  async getPreferences(workspaceId: string, userId: string): Promise<NotificationPreferences> {
    const rows = await getPgDb()
      .select({ category: notificationPreferences.category, enabled: notificationPreferences.enabled })
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.workspaceId, workspaceId),
          eq(notificationPreferences.userId, userId),
          inArray(notificationPreferences.category, [...NOTIFICATION_CATEGORIES]),
        ),
      );
    const preferences: NotificationPreferences = { ...DEFAULT_NOTIFICATION_PREFERENCES };
    for (const row of rows) {
      preferences[row.category as NotificationCategory] = row.enabled;
    }
    return preferences;
  }

  async updatePreferences(
    workspaceId: string,
    userId: string,
    update: NotificationPreferencesUpdate,
  ): Promise<NotificationPreferences> {
    const values = NOTIFICATION_CATEGORIES.filter((category) => typeof update[category] === "boolean").map(
      (category) => ({
        workspaceId,
        userId,
        category,
        enabled: update[category] as boolean,
        updatedAt: DB_NOW_MS,
      }),
    );
    if (values.length > 0) {
      await getPgDb()
        .insert(notificationPreferences)
        .values(values)
        .onConflictDoUpdate({
          target: [
            notificationPreferences.workspaceId,
            notificationPreferences.userId,
            notificationPreferences.category,
          ],
          set: {
            enabled: sql`excluded."enabled"`,
            updatedAt: sql`excluded."updated_at"`,
          },
        });
    }
    return this.getPreferences(workspaceId, userId);
  }
}

function toDomain(row: SelectedRow): CollaborationNotification {
  const category = row.category as NotificationCategory;
  const commentBased = category === "mention" || category === "comment";
  const commentLive = row.liveCommentId !== null && row.commentDeletedAt === null;
  // Deleted-comment privacy (2C.4): a mention/comment notification names its
  // actor only while the comment is live. Otherwise only while the actor
  // still has a membership row in this workspace.
  const showActor = row.actorId !== null && row.actorMemberId !== null && (!commentBased || commentLive);

  return {
    id: row.id,
    category,
    read: row.readAt !== null,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    archived: row.archivedAt !== null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    actor: showActor ? { id: row.actorId!, name: row.actorName ?? null } : null,
    task:
      row.taskId !== null && row.taskTitle !== null && row.taskProjectId !== null
        ? { id: row.taskId, title: row.taskTitle, projectId: row.taskProjectId }
        : null,
    project:
      row.projectId !== null && row.projectName !== null ? { id: row.projectId, name: row.projectName } : null,
    comment: row.commentId !== null ? { id: row.commentId, deleted: !commentLive } : null,
    details: sanitizeNotificationDetails(category, row.details),
  };
}

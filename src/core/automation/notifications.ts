import "server-only";

import { desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { notifications } from "@/db/schema";
import { createId } from "@/lib/ids";
import type { NotificationRow } from "@/db/schema";

export type NotificationLevel = "info" | "success" | "warning";

export interface NotifyInput {
  title: string;
  body?: string | null;
  level?: NotificationLevel;
  href?: string | null;
  source?: string | null;
}

/** How many to keep. Older ones are pruned, like the activity log. */
const RETENTION = 200;

export async function notify(input: NotifyInput): Promise<void> {
  db.insert(notifications)
    .values({
      id: createId("ntf"),
      title: input.title,
      body: input.body ?? null,
      level: input.level ?? "info",
      href: input.href ?? null,
      source: input.source ?? null,
      createdAt: new Date().toISOString(),
    })
    .run();

  db.run(sql`
    delete from ${notifications}
    where ${notifications.createdAt} < (
      select ${notifications.createdAt} from ${notifications}
      order by ${notifications.createdAt} desc limit 1 offset ${RETENTION}
    )
  `);
}

export async function listNotifications(limit = 50): Promise<NotificationRow[]> {
  return db
    .select()
    .from(notifications)
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
    .all();
}

export async function unreadCount(): Promise<number> {
  return (
    db.get<{ c: number }>(
      sql`select count(*) as c from ${notifications} where ${notifications.readAt} is null`,
    )?.c ?? 0
  );
}

export async function markAllRead(): Promise<void> {
  db.update(notifications)
    .set({ readAt: new Date().toISOString() })
    .where(isNull(notifications.readAt))
    .run();
}

export async function markRead(id: string): Promise<void> {
  db.update(notifications)
    .set({ readAt: new Date().toISOString() })
    .where(eq(notifications.id, id))
    .run();
}

export async function clearNotifications(): Promise<void> {
  db.delete(notifications).run();
}

import { NextResponse, type NextRequest } from "next/server";
import { notificationRepository } from "@/db/repositories";
import { notificationListQuerySchema, searchParamsToObject } from "@/core/notifications/schema";
import { InvalidNotificationCursorError } from "@/core/notifications/cursor";
import { inboxJson, resolveInboxContext } from "@/core/notifications/request-context";

export const dynamic = "force-dynamic";

/**
 * GET /api/inbox?view=inbox|archived&filter=all|unread&limit=&cursor=
 *
 * The caller's own collaboration notifications in their active workspace,
 * newest first (created_at DESC, id DESC), with a strict opaque cursor.
 * See docs/design/2C.6-collaboration-notifications.md §7–§8.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await resolveInboxContext(request);
  if (context instanceof NextResponse) return context;

  const raw = searchParamsToObject(new URL(request.url).searchParams);
  if (!raw) return inboxJson({ error: "Query parameters may not be repeated." }, 400);
  const parsed = notificationListQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return inboxJson({ error: parsed.error.issues[0]?.message ?? "Invalid query." }, 400);
  }

  try {
    const [page, unreadCount] = await Promise.all([
      notificationRepository.list(context.workspaceId, context.userId, parsed.data),
      notificationRepository.unreadCount(context.workspaceId, context.userId),
    ]);
    return inboxJson({ workspaceId: context.workspaceId, ...page, unreadCount });
  } catch (error) {
    if (error instanceof InvalidNotificationCursorError) {
      return inboxJson({ error: error.message }, 400);
    }
    throw error;
  }
}

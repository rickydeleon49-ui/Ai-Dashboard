import { NextResponse, type NextRequest } from "next/server";
import { notificationRepository } from "@/db/repositories";
import { notificationStateChangeSchema } from "@/core/notifications/schema";
import { inboxJson, inboxNotFound, resolveInboxContext } from "@/core/notifications/request-context";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const NOT_FOUND = "Notification not found.";

/**
 * PATCH /api/inbox/:id  { read?: boolean, archived?: boolean }
 *
 * Changes the read and/or archived state of one of the caller's own
 * notifications. Unknown, malformed and foreign ids all get the same 404, so
 * the response never reveals whether another user's notification exists.
 */
export async function PATCH(request: NextRequest, { params }: Context): Promise<NextResponse> {
  const context = await resolveInboxContext(request);
  if (context instanceof NextResponse) return context;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return inboxJson({ error: "Body must be JSON." }, 400);
  }
  const parsed = notificationStateChangeSchema.safeParse(body);
  if (!parsed.success) {
    return inboxJson({ error: parsed.error.issues[0]?.message ?? "Invalid change." }, 400);
  }

  const { id } = await params;
  const notification = await notificationRepository.updateState(
    context.workspaceId,
    context.userId,
    id,
    parsed.data,
  );
  if (!notification) return inboxNotFound(NOT_FOUND);

  const unreadCount = await notificationRepository.unreadCount(context.workspaceId, context.userId);
  return inboxJson({ workspaceId: context.workspaceId, notification, unreadCount });
}

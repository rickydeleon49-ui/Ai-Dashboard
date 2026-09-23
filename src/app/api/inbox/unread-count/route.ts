import { NextResponse, type NextRequest } from "next/server";
import { notificationRepository } from "@/db/repositories";
import { inboxJson, resolveInboxContext } from "@/core/notifications/request-context";

export const dynamic = "force-dynamic";

/** GET /api/inbox/unread-count — unread, unarchived, own, active workspace only. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await resolveInboxContext(request);
  if (context instanceof NextResponse) return context;

  const unreadCount = await notificationRepository.unreadCount(context.workspaceId, context.userId);
  return inboxJson({ workspaceId: context.workspaceId, unreadCount });
}

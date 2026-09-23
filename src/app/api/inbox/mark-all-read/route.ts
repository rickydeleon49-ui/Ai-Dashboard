import { NextResponse, type NextRequest } from "next/server";
import { notificationRepository } from "@/db/repositories";
import { inboxJson, resolveInboxContext } from "@/core/notifications/request-context";

export const dynamic = "force-dynamic";

/**
 * POST /api/inbox/mark-all-read — marks every unread notification of the
 * caller in their active workspace read. Bounded in SQL to that recipient and
 * that workspace; other workspaces and other users are untouched.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const context = await resolveInboxContext(request);
  if (context instanceof NextResponse) return context;

  const updated = await notificationRepository.markAllRead(context.workspaceId, context.userId);
  const unreadCount = await notificationRepository.unreadCount(context.workspaceId, context.userId);
  return inboxJson({ workspaceId: context.workspaceId, updated, unreadCount });
}

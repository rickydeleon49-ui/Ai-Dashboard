import { NextResponse, type NextRequest } from "next/server";
import { notificationRepository } from "@/db/repositories";
import { notificationPreferencesUpdateSchema } from "@/core/notifications/schema";
import { inboxJson, resolveInboxContext } from "@/core/notifications/request-context";

export const dynamic = "force-dynamic";

/** GET /api/inbox/preferences — the caller's effective preferences in their active workspace. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await resolveInboxContext(request);
  if (context instanceof NextResponse) return context;

  const preferences = await notificationRepository.getPreferences(context.workspaceId, context.userId);
  return inboxJson({ workspaceId: context.workspaceId, preferences });
}

/**
 * PATCH /api/inbox/preferences  { assignment?, mention?, comment?, due_date? }
 *
 * Partial update: only the categories present are written; the rest keep
 * their current value. Unknown categories and non-boolean values are 400.
 * Always the session user's own preferences — no user id is accepted.
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const context = await resolveInboxContext(request);
  if (context instanceof NextResponse) return context;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return inboxJson({ error: "Body must be JSON." }, 400);
  }
  const parsed = notificationPreferencesUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return inboxJson({ error: parsed.error.issues[0]?.message ?? "Invalid preferences." }, 400);
  }

  const preferences = await notificationRepository.updatePreferences(
    context.workspaceId,
    context.userId,
    parsed.data,
  );
  return inboxJson({ workspaceId: context.workspaceId, preferences });
}

import { NextResponse, type NextRequest } from "next/server";
import { calendarRepository } from "@/db/repositories";
import { CalendarQueryError, parseFilterOptionsQuery } from "@/core/calendar/query";
import { calendarJson, resolveCalendarContext } from "@/core/calendar/request-context";

export const dynamic = "force-dynamic";

/**
 * GET /api/calendar/filters — the current workspace's projects and ACTIVE
 * members for the calendar filters. Members carry `id` and `name` only; no
 * email, image, role or status (design note §3).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await resolveCalendarContext(request);
  if (context instanceof NextResponse) return context;

  try {
    parseFilterOptionsQuery(new URL(request.url).searchParams);
  } catch (error) {
    if (error instanceof CalendarQueryError) return calendarJson({ error: error.message }, 400);
    throw error;
  }

  const options = await calendarRepository.listFilterOptions(context.workspaceId);
  return calendarJson({ workspaceId: context.workspaceId, ...options, canReschedule: context.canReschedule });
}

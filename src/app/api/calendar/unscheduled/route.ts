import { NextResponse, type NextRequest } from "next/server";
import { calendarRepository } from "@/db/repositories";
import { CalendarQueryError, parseUnscheduledQuery } from "@/core/calendar/query";
import {
  calendarJson,
  resolveCalendarContext,
  resolveCalendarFilters,
  unknownFilterResponse,
} from "@/core/calendar/request-context";

export const dynamic = "force-dynamic";

/**
 * GET /api/calendar/unscheduled?[projectId&assignee&status&limit&cursor]
 *
 * Tasks with no due date in the current workspace, 1–50 per page (default 25),
 * keyset-paged over (created_at, id) with a strict opaque cursor.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await resolveCalendarContext(request);
  if (context instanceof NextResponse) return context;

  let query;
  try {
    query = parseUnscheduledQuery(new URL(request.url).searchParams);
  } catch (error) {
    if (error instanceof CalendarQueryError) return calendarJson({ error: error.message }, 400);
    throw error;
  }

  const filters = await resolveCalendarFilters(context, query);
  if (!filters) return unknownFilterResponse();

  const page = await calendarRepository.listUnscheduled(
    context.workspaceId,
    { projectId: filters.projectId, assignee: filters.assignee, status: filters.status },
    { limit: query.limit, cursor: query.cursor },
  );
  return calendarJson({ workspaceId: context.workspaceId, ...page, canReschedule: context.canReschedule });
}

import { NextResponse, type NextRequest } from "next/server";
import { calendarRepository } from "@/db/repositories";
import { CalendarQueryError, parseCalendarRangeQuery } from "@/core/calendar/query";
import { MAX_CALENDAR_ITEMS } from "@/core/calendar/types";
import { todayInTimeZone } from "@/core/calendar/dates";
import {
  calendarJson,
  resolveCalendarContext,
  resolveCalendarFilters,
  unknownFilterResponse,
} from "@/core/calendar/request-context";

export const dynamic = "force-dynamic";

/**
 * GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD[&projectId&assignee&status&kind&tz]
 *
 * Task and milestone due dates in the current workspace whose calendar day
 * (UTC date of the stored value) falls in the inclusive range. The range is
 * strictly validated and at most 42 days; the result is capped.
 * See docs/design/2D.1-calendar.md §2–§3.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await resolveCalendarContext(request);
  if (context instanceof NextResponse) return context;

  let query;
  try {
    query = parseCalendarRangeQuery(new URL(request.url).searchParams);
  } catch (error) {
    if (error instanceof CalendarQueryError) return calendarJson({ error: error.message }, 400);
    throw error;
  }

  const filters = await resolveCalendarFilters(context, query);
  if (!filters) return unknownFilterResponse();

  const timeZone = query.tz ?? "UTC";
  const result = await calendarRepository.listRange(
    context.workspaceId,
    { from: query.from, to: query.to },
    filters,
    MAX_CALENDAR_ITEMS,
  );
  return calendarJson({
    workspaceId: context.workspaceId,
    from: query.from,
    to: query.to,
    timeZone,
    today: todayInTimeZone(timeZone),
    items: result.items,
    truncated: result.truncated,
    canReschedule: context.canReschedule,
  });
}

import { NextResponse, type NextRequest } from "next/server";
import { calendarRepository } from "@/db/repositories";
import { CalendarQueryError, parseFilterSearchQuery } from "@/core/calendar/query";
import { calendarJson, resolveCalendarContext } from "@/core/calendar/request-context";

export const dynamic = "force-dynamic";

/**
 * GET /api/calendar/filters/search?type=projects|members&q=&limit=&cursor=
 *
 * Bounded, keyset-paged name search for filter values that fall beyond the
 * initial filter-option lists (design note §3). Scoped to the caller's current
 * workspace in SQL; any active role (viewer and up) may search.
 *
 * Deliberately NOT the members directory API: that returns email, image, role
 * and status, and the calendar must never receive them. This returns `id` and
 * `name` only, matches on the name alone, and lists ACTIVE members only.
 * Member search exists only in accounts mode; desktop has no users.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await resolveCalendarContext(request);
  if (context instanceof NextResponse) return context;

  let query;
  try {
    query = parseFilterSearchQuery(new URL(request.url).searchParams);
  } catch (error) {
    if (error instanceof CalendarQueryError) return calendarJson({ error: error.message }, 400);
    throw error;
  }
  if (query.type === "members" && !context.userId) {
    return calendarJson({ error: "Member search is only available with accounts." }, 400);
  }

  const page = await calendarRepository.searchFilterOptions(context.workspaceId, query.type, {
    q: query.q,
    limit: query.limit,
    cursor: query.cursor,
  });
  return calendarJson({ workspaceId: context.workspaceId, type: query.type, q: query.q, ...page });
}

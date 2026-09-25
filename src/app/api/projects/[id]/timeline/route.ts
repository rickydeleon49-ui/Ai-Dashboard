import { NextResponse, type NextRequest } from "next/server";
import { timelineRepository } from "@/db/repositories";
import { todayInTimeZone } from "@/core/calendar/dates";
import { calendarJson, resolveCalendarContext } from "@/core/calendar/request-context";
import { analyzeTimeline } from "@/core/timeline/blocking";
import { TimelineAnalysisBudgetError } from "@/core/timeline/explore";
import { TimelineQueryError, isTimelineProjectId, parseTimelineQuery } from "@/core/timeline/query";
import { timelineRange } from "@/core/timeline/range";
import { TIMELINE_LIMITS, type TimelineResponse } from "@/core/timeline/types";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Identical for a malformed, nonexistent or other-workspace project id. */
function projectNotFound(): NextResponse {
  return calendarJson({ error: "Project not found" }, 404);
}

/**
 * GET /api/projects/[id]/timeline?zoom=week|month|quarter&anchor=YYYY-MM-DD[&tz]
 *
 * Read-only project timeline (Release 2D.2, docs/design/2D.2-timeline.md).
 * Any active workspace role may read it. The workspace comes from the
 * session/cookie resolution, never from the query; the window is derived on
 * the server from zoom + anchor; every list is capped with truncation flags.
 */
export async function GET(request: NextRequest, { params }: Context): Promise<NextResponse> {
  const context = await resolveCalendarContext(request);
  if (context instanceof NextResponse) return context;

  let query;
  try {
    query = parseTimelineQuery(new URL(request.url).searchParams);
  } catch (error) {
    if (error instanceof TimelineQueryError) return calendarJson({ error: error.message }, 400);
    throw error;
  }

  const { id } = await params;
  if (!isTimelineProjectId(id)) return projectNotFound();

  const range = timelineRange(query.zoom, query.anchor);
  let data;
  try {
    data = await timelineRepository.load(context.workspaceId, id, { from: range.from, to: range.to }, TIMELINE_LIMITS);
  } catch (error) {
    // The exact blocked-state analysis hit its workload guard: say so, never guess.
    if (error instanceof TimelineAnalysisBudgetError) {
      return calendarJson({ error: "This project's dependency graph is too large to analyse right now." }, 503);
    }
    throw error;
  }
  if (!data) return projectNotFound();

  const analysis = analyzeTimeline(data);

  let assignees: TimelineResponse["assignees"] = [];
  if (context.userId) {
    const ids = [...analysis.items, ...analysis.undated].flatMap((item) =>
      item.kind === "task" && item.assigneeId ? [item.assigneeId] : [],
    );
    if (ids.length > 0) {
      const { getMemberDisplaySummaries } = await import("@/core/workspaces/service");
      // Names only: the timeline never carries email, image, role or status.
      assignees = (await getMemberDisplaySummaries(context.workspaceId, ids, "viewer")).map((m) => ({
        id: m.id,
        name: m.name,
      }));
    }
  }

  const timeZone = query.tz ?? "UTC";
  const body: TimelineResponse = {
    workspaceId: context.workspaceId,
    projectId: data.project.id,
    projectName: data.project.name,
    zoom: query.zoom,
    anchor: query.anchor,
    from: range.from,
    to: range.to,
    timeZone,
    today: todayInTimeZone(timeZone),
    items: analysis.items,
    undated: analysis.undated,
    nodes: analysis.nodes,
    edges: analysis.edges,
    assignees,
    limits: TIMELINE_LIMITS,
    truncated: data.truncated,
    editable: false,
  };
  return calendarJson(body);
}

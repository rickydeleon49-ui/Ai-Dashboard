/**
 * Browser-side read for the Release 2D.2 timeline. A response is accepted
 * only if it answers exactly the request that was made — same workspace,
 * project, zoom and anchor — so a response computed before a workspace
 * switch or a navigation can never be applied.
 */
import type { DateOnly } from "@/core/calendar/dates";
import type { TimelineResponse, TimelineZoom } from "@/core/timeline/types";

export class TimelineRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TimelineRequestError";
    this.status = status;
  }
}

/** The response belongs to another workspace, project or window. */
export class StaleTimelineError extends Error {
  constructor() {
    super("The timeline changed while this request was in flight.");
    this.name = "StaleTimelineError";
  }
}

export interface TimelineRequest {
  workspaceId: string;
  projectId: string;
  zoom: TimelineZoom;
  anchor: DateOnly;
  timeZone: string;
}

export async function fetchTimeline(request: TimelineRequest, signal?: AbortSignal): Promise<TimelineResponse> {
  const params = new URLSearchParams({ zoom: request.zoom, anchor: request.anchor, tz: request.timeZone });
  const response = await fetch(
    `/api/projects/${encodeURIComponent(request.projectId)}/timeline?${params.toString()}`,
    { cache: "no-store", signal },
  );
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Request failed (${response.status}).`;
    throw new TimelineRequestError(response.status, message);
  }
  const data = body as TimelineResponse | null;
  if (
    !data ||
    data.workspaceId !== request.workspaceId ||
    data.projectId !== request.projectId ||
    data.zoom !== request.zoom ||
    data.anchor !== request.anchor
  ) {
    throw new StaleTimelineError();
  }
  return data;
}

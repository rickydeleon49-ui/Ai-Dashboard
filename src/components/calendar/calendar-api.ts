/**
 * Browser-side calls for the Release 2D.1 calendar. Reads reject any response
 * computed for another workspace (a request in flight across a workspace
 * switch). Writes go to the EXISTING task and milestone routes, which own
 * authorization and every domain invariant.
 */
import type { DateOnly } from "@/core/calendar/dates";
import type { CalendarItem, UnscheduledTask } from "@/core/calendar/types";

export class StaleWorkspaceError extends Error {
  constructor() {
    super("The active workspace changed.");
    this.name = "StaleWorkspaceError";
  }
}

export class CalendarRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CalendarRequestError";
    this.status = status;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
  return `Request failed (${status}).`;
}

async function getScoped<T extends { workspaceId: string }>(
  workspaceId: string,
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, { cache: "no-store", signal });
  const body = await readJson(response);
  if (!response.ok) throw new CalendarRequestError(response.status, errorMessage(response.status, body));
  const data = body as T;
  if (!data || data.workspaceId !== workspaceId) throw new StaleWorkspaceError();
  return data;
}

export interface CalendarFilterState {
  projectId: string;
  assignee: string;
  status: string;
  kind: string;
}

function filterParams(filters: CalendarFilterState, includeKind: boolean): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.projectId) params.set("projectId", filters.projectId);
  if (filters.assignee) params.set("assignee", filters.assignee);
  if (filters.status !== "all") params.set("status", filters.status);
  if (includeKind && filters.kind !== "all") params.set("kind", filters.kind);
  return params;
}

export interface RangeResponse {
  workspaceId: string;
  from: DateOnly;
  to: DateOnly;
  today: DateOnly;
  timeZone: string;
  items: CalendarItem[];
  truncated: boolean;
  canReschedule: boolean;
}

export function fetchRange(
  workspaceId: string,
  range: { from: DateOnly; to: DateOnly },
  filters: CalendarFilterState,
  timeZone: string,
  signal?: AbortSignal,
): Promise<RangeResponse> {
  const params = filterParams(filters, true);
  params.set("from", range.from);
  params.set("to", range.to);
  params.set("tz", timeZone);
  return getScoped<RangeResponse>(workspaceId, `/api/calendar?${params.toString()}`, signal);
}

export interface UnscheduledResponse {
  workspaceId: string;
  items: UnscheduledTask[];
  nextCursor: string | null;
  canReschedule: boolean;
}

export function fetchUnscheduled(
  workspaceId: string,
  filters: CalendarFilterState,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<UnscheduledResponse> {
  const params = filterParams(filters, false);
  params.set("limit", "25");
  if (cursor) params.set("cursor", cursor);
  return getScoped<UnscheduledResponse>(workspaceId, `/api/calendar/unscheduled?${params.toString()}`, signal);
}

export interface FilterOptionsResponse {
  workspaceId: string;
  projects: { id: string; name: string }[];
  projectsTruncated: boolean;
  projectLimit: number;
  members: { id: string; name: string | null }[];
  membersTruncated: boolean;
  memberLimit: number;
  canReschedule: boolean;
}

export function fetchFilterOptions(workspaceId: string, signal?: AbortSignal): Promise<FilterOptionsResponse> {
  return getScoped<FilterOptionsResponse>(workspaceId, "/api/calendar/filters", signal);
}

export interface FilterSearchResponse {
  workspaceId: string;
  type: "projects" | "members";
  q: string;
  results: { id: string; name: string | null }[];
  nextCursor: string | null;
}

/** Bounded name search for filter values beyond the initial option lists. */
export function searchFilterOptions(
  workspaceId: string,
  type: "projects" | "members",
  q: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<FilterSearchResponse> {
  const params = new URLSearchParams({ type, q, limit: "25" });
  if (cursor) params.set("cursor", cursor);
  return getScoped<FilterSearchResponse>(workspaceId, `/api/calendar/filters/search?${params.toString()}`, signal);
}

/** Persists a new due date through the existing route for the item's kind. */
export async function saveDueDate(
  item: Pick<CalendarItem, "kind" | "id" | "projectId">,
  date: DateOnly,
): Promise<void> {
  const path =
    item.kind === "task"
      ? `/api/tasks/${encodeURIComponent(item.id)}`
      : `/api/projects/${encodeURIComponent(item.projectId)}/milestones/${encodeURIComponent(item.id)}`;
  const response = await fetch(path, {
    method: "PATCH",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dueDate: date }),
  });
  if (!response.ok) {
    throw new CalendarRequestError(response.status, errorMessage(response.status, await readJson(response)));
  }
}

export async function switchWorkspace(workspaceId: string): Promise<void> {
  const response = await fetch("/api/workspaces/current", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
  if (!response.ok) {
    throw new CalendarRequestError(response.status, errorMessage(response.status, await readJson(response)));
  }
}

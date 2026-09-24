/** Release 2D.1 calendar domain types. See docs/design/2D.1-calendar.md. */
import type { DateOnly } from "./dates";

export const CALENDAR_STATUSES = ["all", "open", "todo", "in_progress", "done", "cancelled"] as const;
export type CalendarStatusFilter = (typeof CALENDAR_STATUSES)[number];

export const CALENDAR_KINDS = ["all", "tasks", "milestones"] as const;
export type CalendarKindFilter = (typeof CALENDAR_KINDS)[number];

export const MAX_CALENDAR_ITEMS = 1000;
export const DEFAULT_UNSCHEDULED_PAGE_SIZE = 25;
export const MAX_UNSCHEDULED_PAGE_SIZE = 50;
/**
 * Independent caps on the filter option lists. Each list is read with
 * `limit + 1` so the response can say truthfully whether it was cut off.
 */
export const MAX_FILTER_PROJECTS = 500;
export const MAX_FILTER_MEMBERS = 500;

/** `me` and `unassigned` are resolved to these before reaching a repository. */
export type AssigneeFilter = { kind: "user"; userId: string } | { kind: "unassigned" };

export interface CalendarFilters {
  projectId?: string;
  assignee?: AssigneeFilter;
  status: CalendarStatusFilter;
  kind: CalendarKindFilter;
}

export interface CalendarItem {
  kind: "task" | "milestone";
  id: string;
  title: string;
  /** Calendar day under the §2 rule (UTC date of the stored value). */
  date: DateOnly;
  projectId: string;
  projectName: string;
  status: string;
  assigneeId: string | null;
}

export interface UnscheduledTask {
  kind: "task";
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  status: string;
  assigneeId: string | null;
}

export interface CalendarRangeResult {
  items: CalendarItem[];
  truncated: boolean;
}

export interface UnscheduledPage {
  items: UnscheduledTask[];
  nextCursor: string | null;
}

/** One page of a filter-option search: id + name only, keyset-paged. */
export interface FilterSearchPage {
  results: { id: string; name: string | null }[];
  nextCursor: string | null;
}

export interface CalendarFilterOptions {
  projects: { id: string; name: string }[];
  /** True when the workspace has more than `projectLimit` projects. */
  projectsTruncated: boolean;
  projectLimit: number;
  members: { id: string; name: string | null }[];
  /** True when the workspace has more than `memberLimit` active members. */
  membersTruncated: boolean;
  memberLimit: number;
}

export const TASK_STATUSES_FOR: Record<CalendarStatusFilter, readonly string[] | null> = {
  all: null,
  open: ["todo", "in_progress"],
  todo: ["todo"],
  in_progress: ["in_progress"],
  done: ["done"],
  cancelled: ["cancelled"],
};

/** How the task status filter maps onto milestone statuses (design note §3). */
export const MILESTONE_STATUSES_FOR: Record<CalendarStatusFilter, readonly string[] | null> = {
  all: null,
  open: ["open"],
  todo: ["open"],
  in_progress: ["open"],
  done: ["completed"],
  cancelled: ["cancelled"],
};

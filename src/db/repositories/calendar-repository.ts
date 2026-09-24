import type { DateOnly } from "@/core/calendar/dates";
import type {
  CalendarFilterOptions,
  CalendarFilters,
  CalendarRangeResult,
  FilterSearchPage,
  UnscheduledPage,
} from "@/core/calendar/types";
import type { FilterSearchCursor } from "@/core/calendar/query";

/**
 * Release 2D.1 calendar reads. Every method takes a mandatory `workspaceId`
 * first argument and scopes in SQL — the same contract as every other
 * repository here. Writes are deliberately absent: rescheduling goes through
 * the existing task and milestone routes and their invariants.
 * See docs/design/2D.1-calendar.md §4.
 */
export interface CalendarRepository {
  /**
   * Task and milestone due dates whose calendar day (UTC date of the stored
   * value) falls in [from, to], inclusive. Exactly two queries; at most
   * `limit` items, with `truncated` when more exist.
   */
  listRange(
    workspaceId: string,
    range: { from: DateOnly; to: DateOnly },
    filters: CalendarFilters,
    limit: number,
  ): Promise<CalendarRangeResult>;
  /** Tasks with no due date, keyset-paged over (created_at, id). */
  listUnscheduled(
    workspaceId: string,
    filters: Omit<CalendarFilters, "kind">,
    page: { limit: number; cursor?: string },
  ): Promise<UnscheduledPage>;
  projectExists(workspaceId: string, projectId: string): Promise<boolean>;
  /** True when `userId` has a membership row (any status) in the workspace. Always false on desktop. */
  memberExists(workspaceId: string, userId: string): Promise<boolean>;
  listFilterOptions(workspaceId: string): Promise<CalendarFilterOptions>;
  /**
   * Bounded, case-insensitive name search over this workspace's projects, or
   * its ACTIVE members (accounts mode only), returning id + name only. Keyset
   * pages over (lower(name), id), so every row is reachable past any cap.
   */
  searchFilterOptions(
    workspaceId: string,
    type: "projects" | "members",
    search: { q: string; limit: number; cursor?: FilterSearchCursor },
  ): Promise<FilterSearchPage>;
}

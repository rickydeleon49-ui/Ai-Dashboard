/**
 * The persistence contract for the Release 2D.2 project timeline
 * (docs/design/2D.2-timeline.md §4). Read-only.
 *
 * `load` answers one project in one workspace with a FIXED number of queries,
 * whatever the project's size: every list is capped (`limit + 1`, so
 * truncation is reported truthfully) and nothing is queried per item.
 * PostgreSQL scopes every query by workspace; SQLite serves only
 * `LOCAL_WORKSPACE_ID`.
 */
import type { DateOnly } from "@/core/calendar/dates";
import type { TimelineData, TimelineLimits } from "@/core/timeline/types";

export interface TimelineRepository {
  /** null when the project does not exist in `workspaceId`. */
  load(
    workspaceId: string,
    projectId: string,
    range: { from: DateOnly; to: DateOnly },
    limits: TimelineLimits,
  ): Promise<TimelineData | null>;
}

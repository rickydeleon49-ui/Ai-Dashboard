/**
 * Strict query parsing for GET /api/projects/[id]/timeline (Release 2D.2).
 * Only `zoom`, `anchor` and `tz`; repeated or unknown parameters are
 * rejected. The window itself is derived on the server from zoom + anchor,
 * so the browser can never request an arbitrary or oversized range.
 */
import { isDateOnly, isValidTimeZone, type DateOnly } from "@/core/calendar/dates";
import { CalendarQueryError, ID_PATTERN, toObject } from "@/core/calendar/query";
import { TIMELINE_ZOOMS, type TimelineZoom } from "./types";

export { CalendarQueryError as TimelineQueryError };

export interface TimelineQuery {
  zoom: TimelineZoom;
  anchor: DateOnly;
  tz?: string;
}

export function parseTimelineQuery(params: URLSearchParams): TimelineQuery {
  const raw = toObject(params, ["zoom", "anchor", "tz"]);
  const zoom = raw.zoom as TimelineZoom;
  if (!TIMELINE_ZOOMS.includes(zoom)) throw new CalendarQueryError("'zoom' must be week, month or quarter.");
  if (!isDateOnly(raw.anchor)) throw new CalendarQueryError("'anchor' must be a valid YYYY-MM-DD date.");
  const query: TimelineQuery = { zoom, anchor: raw.anchor };
  if (raw.tz !== undefined) {
    if (!isValidTimeZone(raw.tz)) throw new CalendarQueryError("Unknown time zone.");
    query.tz = raw.tz;
  }
  return query;
}

/** Project ids are opaque; anything outside the id alphabet is simply not found. */
export function isTimelineProjectId(value: string): boolean {
  return ID_PATTERN.test(value);
}

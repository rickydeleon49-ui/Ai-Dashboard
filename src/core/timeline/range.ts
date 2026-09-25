/**
 * Release 2D.2 timeline windows. Built entirely on the Calendar's date-only
 * arithmetic (`src/core/calendar/dates.ts`): no local-time Date math, so no
 * zone or daylight-saving transition can move a day. See
 * docs/design/2D.2-timeline.md §3.
 */
import {
  addDays,
  addMonths,
  daysInMonth,
  diffDays,
  formatDateOnly,
  monthRange,
  parseDateOnly,
  shiftPeriod,
  weekRange,
  type CalendarRange,
  type DateOnly,
} from "@/core/calendar/dates";
import { MAX_TIMELINE_DAYS, type TimelineZoom } from "./types";

function daysBetween(from: DateOnly, to: DateOnly): DateOnly[] {
  const count = diffDays(from, to);
  const days: DateOnly[] = [];
  for (let i = 0; i <= count; i++) days.push(addDays(from, i));
  return days;
}

/** First day of the calendar quarter containing `anchor`. */
export function firstOfQuarter(anchor: DateOnly): DateOnly {
  const { year, month } = parseDateOnly(anchor);
  return formatDateOnly(year, Math.floor((month - 1) / 3) * 3 + 1, 1);
}

/**
 * Full ISO weeks covering the anchor's calendar quarter, clamped to the
 * supported calendar (at most 15 weeks).
 */
export function quarterRange(anchor: DateOnly): CalendarRange {
  const first = firstOfQuarter(anchor);
  const { year, month } = parseDateOnly(first);
  const last = formatDateOnly(year, month + 2, daysInMonth(year, month + 2));
  const from = weekRange(first).from;
  const to = weekRange(last).to;
  return { from, to, days: daysBetween(from, to) };
}

/** The window for `zoom` around `anchor`. Always within MAX_TIMELINE_DAYS. */
export function timelineRange(zoom: TimelineZoom, anchor: DateOnly): CalendarRange {
  const range = zoom === "week" ? weekRange(anchor) : zoom === "month" ? monthRange(anchor) : quarterRange(anchor);
  if (range.days.length > MAX_TIMELINE_DAYS) {
    // Unreachable by construction; a guard so no caller can exceed the bound.
    throw new Error(`Timeline window exceeds ${MAX_TIMELINE_DAYS} days.`);
  }
  return range;
}

/**
 * The anchor of the adjacent window (`step` 1 = next, -1 = previous), or null
 * when that window would lie entirely outside the supported calendar.
 */
export function shiftTimeline(zoom: TimelineZoom, anchor: DateOnly, step: 1 | -1): DateOnly | null {
  if (zoom === "week" || zoom === "month") return shiftPeriod(zoom, anchor, step);
  return addMonths(firstOfQuarter(anchor), step * 3);
}

/** A stable anchor for a window: the window's own first day of the period. */
export function normalizeAnchor(zoom: TimelineZoom, anchor: DateOnly): DateOnly {
  if (zoom === "week") return weekRange(anchor).from;
  if (zoom === "month") {
    const { year, month } = parseDateOnly(anchor);
    return formatDateOnly(year, month, 1);
  }
  return firstOfQuarter(anchor);
}

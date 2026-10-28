/**
 * Display helpers for date-only due dates and for instants shown to the
 * browser, following docs/design/2D.1-calendar.md §2: a due date's calendar
 * day is the UTC date of the stored value, and only "today" comes from the
 * browser's time zone. Everything here renders identically on the server and
 * in the browser, so it is safe inside server-rendered client components.
 */
import { calendarDayOf, formatDayLabel, type DateOnly } from "@/core/calendar/dates";

const LOCALE = "en-US";
const DAY_OPTIONS: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };

/** "Oct 2, 2026" for a stored due date, never shifted by any time zone. "—" when empty. */
export function formatDueDate(stored: string | null | undefined): string {
  const day = calendarDayOf(stored);
  return day ? formatDayLabel(day, DAY_OPTIONS, LOCALE) : "—";
}

/** True when the due date's calendar day is before `today`. Unknown today → not overdue. */
export function isDueBefore(stored: string | null | undefined, today: DateOnly | null): boolean {
  if (!today) return false;
  const day = calendarDayOf(stored);
  return day !== null && day < today;
}

/**
 * An instant (createdAt, assignedAt, …) as a calendar date in `timeZone`.
 * Returns null until the browser's zone is known, so the server renders
 * nothing rather than a date in its own zone.
 */
export function formatInstantDate(iso: string | null | undefined, timeZone: string | null): string | null {
  if (!iso || !timeZone) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(LOCALE, { ...DAY_OPTIONS, timeZone });
}

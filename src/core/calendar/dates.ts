/**
 * Release 2D.1 calendar date arithmetic — framework-free, and deliberately
 * free of local-time `Date` math. See docs/design/2D.1-calendar.md §2.
 *
 * Every calendar day is a `YYYY-MM-DD` string. Arithmetic goes through
 * `Date.UTC`, which has no daylight-saving time, so no browser or server time
 * zone can duplicate, skip or shift a day. The browser's IANA zone is used for
 * exactly one thing: deciding what "today" is (`todayInTimeZone`).
 */

export type DateOnly = string;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
export const MIN_YEAR = 1900;
export const MAX_YEAR = 9999;
/** The supported calendar, inclusive at both ends. */
export const MIN_DATE: DateOnly = "1900-01-01";
export const MAX_DATE: DateOnly = "9999-12-31";
/** The largest month grid is six weeks. */
export const MAX_RANGE_DAYS = 42;
const DAY_MS = 86_400_000;

export class InvalidCalendarDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCalendarDateError";
  }
}

/** Strictly validates a `YYYY-MM-DD` string that names a real calendar day. */
export function isDateOnly(value: unknown): value is DateOnly {
  if (typeof value !== "string") return false;
  const match = DATE_ONLY.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

export function parseDateOnly(value: string): { year: number; month: number; day: number } {
  if (!isDateOnly(value)) throw new InvalidCalendarDateError(`Invalid date: expected YYYY-MM-DD.`);
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return { year, month, day };
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

export function formatDateOnly(year: number, month: number, day: number): DateOnly {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function toUtcMs(value: DateOnly): number {
  const { year, month, day } = parseDateOnly(value);
  return Date.UTC(year, month - 1, day);
}

function fromUtcMs(ms: number): DateOnly {
  const d = new Date(ms);
  return formatDateOnly(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Raw day arithmetic. The result may fall outside MIN_DATE..MAX_DATE (for
 * example `addDays("9999-12-31", 1)` is "10000-01-01"), so it must never be
 * compared as a string or parsed again without `isDateOnly`. Grids and
 * navigation use `shiftPeriod` and the clamped ranges below instead;
 * `isDateOnly` also enforces MIN_DATE..MAX_DATE.
 */
export function addDays(value: DateOnly, days: number): DateOnly {
  return fromUtcMs(toUtcMs(value) + days * DAY_MS);
}


/** Whole days from `from` to `to` (to − from). */
export function diffDays(from: DateOnly, to: DateOnly): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

/** ISO weekday, Monday = 0 … Sunday = 6. */
export function isoWeekday(value: DateOnly): number {
  return (new Date(toUtcMs(value)).getUTCDay() + 6) % 7;
}

export function startOfWeek(value: DateOnly): DateOnly {
  return addDays(value, -isoWeekday(value));
}

export interface CalendarRange {
  from: DateOnly;
  to: DateOnly;
  days: DateOnly[];
}

/**
 * The days from `startMs` to `endMs` (UTC midnights, inclusive), clamped to
 * the supported calendar. Iterates numerically, never by comparing strings,
 * so year 10000 can't end the loop early.
 */
function rangeOf(startMs: number, endMs: number): CalendarRange {
  const lo = Math.max(startMs, toUtcMs(MIN_DATE));
  const hi = Math.min(endMs, toUtcMs(MAX_DATE));
  const days: DateOnly[] = [];
  for (let ms = lo; ms <= hi; ms += DAY_MS) days.push(fromUtcMs(ms));
  return { from: days[0]!, to: days[days.length - 1]!, days };
}

/** Monday–Sunday week containing `anchor`. */
export function weekRange(anchor: DateOnly): CalendarRange {
  const start = toUtcMs(anchor) - isoWeekday(anchor) * DAY_MS;
  return rangeOf(start, start + 6 * DAY_MS);
}

/**
 * Full ISO weeks covering the month containing `anchor` (4–6 weeks), clamped
 * to the supported calendar: December 9999 ends on Friday 9999-12-31 rather
 * than spilling into year 10000.
 */
export function monthRange(anchor: DateOnly): CalendarRange {
  const { year, month } = parseDateOnly(anchor);
  const first = formatDateOnly(year, month, 1);
  const last = formatDateOnly(year, month, daysInMonth(year, month));
  const start = toUtcMs(first) - isoWeekday(first) * DAY_MS;
  const end = toUtcMs(last) + (6 - isoWeekday(last)) * DAY_MS;
  return rangeOf(start, end);
}

export function firstOfMonth(value: DateOnly): DateOnly {
  const { year, month } = parseDateOnly(value);
  return formatDateOnly(year, month, 1);
}

/**
 * The first of the month `months` away. Returns null outside the supported
 * calendar (before January 1900 or after December 9999).
 */
export function addMonths(value: DateOnly, months: number): DateOnly | null {
  const { year, month } = parseDateOnly(value);
  const index = year * 12 + (month - 1) + months;
  const result = formatDateOnly(Math.floor(index / 12), (index % 12) + 1, 1);
  return isDateOnly(result) ? result : null;
}

/**
 * The anchor of the next (`step` = 1) or previous (`step` = -1) period, or
 * null when that period would lie entirely outside the supported calendar.
 * A partially supported period (the week containing 9999-12-31) is allowed;
 * its grid is clamped.
 */
export function shiftPeriod(view: "month" | "week", anchor: DateOnly, step: 1 | -1): DateOnly | null {
  if (view === "month") return addMonths(firstOfMonth(anchor), step);
  const current = weekRange(anchor);
  const edge = step === 1 ? addDays(current.to, 1) : addDays(current.from, -1);
  return isDateOnly(edge) ? edge : null;
}

/**
 * The calendar day of a stored due date: its UTC calendar date (§2). A bare
 * `YYYY-MM-DD` is returned unchanged; anything else unparseable is null.
 */
export function calendarDayOf(stored: string | Date | null | undefined): DateOnly | null {
  if (stored === null || stored === undefined || stored === "") return null;
  if (typeof stored === "string" && isDateOnly(stored)) return stored;
  const date = stored instanceof Date ? stored : new Date(stored);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return null;
  const day = fromUtcMs(ms);
  return isDateOnly(day) ? day : null;
}

/** Validates an IANA time zone name without trusting arbitrary strings. */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  if (!/^[A-Za-z0-9_+\-/]+$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Today's calendar date in `timeZone`, computed without locale-dependent parsing. */
export function todayInTimeZone(timeZone: string, now: Date = new Date()): DateOnly {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return formatDateOnly(get("year"), get("month"), get("day"));
}

/** Validates an inclusive query range: strict dates, from ≤ to, span ≤ MAX_RANGE_DAYS. */
export function validateRange(from: unknown, to: unknown): { from: DateOnly; to: DateOnly } {
  if (!isDateOnly(from) || !isDateOnly(to)) {
    throw new InvalidCalendarDateError("'from' and 'to' must be valid YYYY-MM-DD dates.");
  }
  const span = diffDays(from, to);
  if (span < 0) throw new InvalidCalendarDateError("'from' must not be after 'to'.");
  if (span + 1 > MAX_RANGE_DAYS) {
    throw new InvalidCalendarDateError(`A calendar range may span at most ${MAX_RANGE_DAYS} days.`);
  }
  return { from, to };
}

/** Human label for a date-only value, formatted in UTC so it can never shift a day. */
export function formatDayLabel(value: DateOnly, options: Intl.DateTimeFormatOptions): string {
  return new Date(toUtcMs(value)).toLocaleDateString(undefined, { ...options, timeZone: "UTC" });
}

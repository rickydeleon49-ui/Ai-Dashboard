/**
 * Strict query parsing for /api/calendar* (Release 2D.1). Locale-independent:
 * dates are only ever accepted as `YYYY-MM-DD`, never through Date.parse.
 * Repeated or unknown parameters are rejected.
 */
import {
  InvalidCalendarDateError,
  isValidTimeZone,
  validateRange,
  type DateOnly,
} from "./dates";
import {
  CALENDAR_KINDS,
  CALENDAR_STATUSES,
  DEFAULT_UNSCHEDULED_PAGE_SIZE,
  MAX_UNSCHEDULED_PAGE_SIZE,
  type CalendarKindFilter,
  type CalendarStatusFilter,
} from "./types";

export class CalendarQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarQueryError";
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

function toObject(params: URLSearchParams, allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of params) {
    if (!allowed.includes(key)) throw new CalendarQueryError(`Unknown query parameter '${key}'.`);
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new CalendarQueryError(`Query parameter '${key}' may not be repeated.`);
    }
    out[key] = value;
  }
  return out;
}

export interface RawCalendarFilters {
  projectId?: string;
  /** `me`, `unassigned`, or a user id — resolved and validated by the route. */
  assignee?: string;
  status: CalendarStatusFilter;
  kind: CalendarKindFilter;
}

function parseFilters(raw: Record<string, string>): RawCalendarFilters {
  const status = (raw.status ?? "all") as CalendarStatusFilter;
  if (!CALENDAR_STATUSES.includes(status)) throw new CalendarQueryError("Unknown status filter.");
  const kind = (raw.kind ?? "all") as CalendarKindFilter;
  if (!CALENDAR_KINDS.includes(kind)) throw new CalendarQueryError("Unknown kind filter.");
  const filters: RawCalendarFilters = { status, kind };
  if (raw.projectId !== undefined) {
    if (!ID_PATTERN.test(raw.projectId)) throw new CalendarQueryError("Unknown filter value.");
    filters.projectId = raw.projectId;
  }
  if (raw.assignee !== undefined) {
    if (raw.assignee !== "me" && raw.assignee !== "unassigned" && !ID_PATTERN.test(raw.assignee)) {
      throw new CalendarQueryError("Unknown filter value.");
    }
    filters.assignee = raw.assignee;
  }
  return filters;
}

export interface CalendarRangeQuery extends RawCalendarFilters {
  from: DateOnly;
  to: DateOnly;
  tz?: string;
}

export function parseCalendarRangeQuery(params: URLSearchParams): CalendarRangeQuery {
  const raw = toObject(params, ["from", "to", "projectId", "assignee", "status", "kind", "tz"]);
  let range: { from: DateOnly; to: DateOnly };
  try {
    range = validateRange(raw.from, raw.to);
  } catch (error) {
    if (error instanceof InvalidCalendarDateError) throw new CalendarQueryError(error.message);
    throw error;
  }
  const query: CalendarRangeQuery = { ...range, ...parseFilters(raw) };
  if (raw.tz !== undefined) {
    if (!isValidTimeZone(raw.tz)) throw new CalendarQueryError("Unknown time zone.");
    query.tz = raw.tz;
  }
  return query;
}

export interface UnscheduledQuery extends RawCalendarFilters {
  limit: number;
  cursor?: string;
}

export function parseUnscheduledQuery(params: URLSearchParams): UnscheduledQuery {
  const raw = toObject(params, ["projectId", "assignee", "status", "limit", "cursor"]);
  const query: UnscheduledQuery = { ...parseFilters(raw), limit: DEFAULT_UNSCHEDULED_PAGE_SIZE };
  if (raw.limit !== undefined) {
    if (!/^[1-9][0-9]{0,2}$/.test(raw.limit) || Number(raw.limit) > MAX_UNSCHEDULED_PAGE_SIZE) {
      throw new CalendarQueryError(`limit must be an integer between 1 and ${MAX_UNSCHEDULED_PAGE_SIZE}.`);
    }
    query.limit = Number(raw.limit);
  }
  if (raw.cursor !== undefined) {
    decodeUnscheduledCursor(raw.cursor);
    query.cursor = raw.cursor;
  }
  return query;
}

export interface UnscheduledCursor {
  createdAt: string;
  id: string;
}

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})?$/;

export function encodeUnscheduledCursor(cursor: UnscheduledCursor): string {
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id })).toString("base64url");
}

/**
 * Strict opaque cursor: bounded length, base64url, a JSON object with exactly
 * `createdAt` (a timestamp as stored) and `id`. Anything else is rejected.
 */
export function decodeUnscheduledCursor(cursor: string): UnscheduledCursor {
  if (cursor.length === 0 || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new CalendarQueryError("Invalid pagination cursor.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
  } catch {
    throw new CalendarQueryError("Invalid pagination cursor.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CalendarQueryError("Invalid pagination cursor.");
  }
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "createdAt" ||
    keys[1] !== "id" ||
    typeof obj.createdAt !== "string" ||
    typeof obj.id !== "string" ||
    !TIMESTAMP_PATTERN.test(obj.createdAt) ||
    !Number.isFinite(new Date(obj.createdAt).getTime()) ||
    !ID_PATTERN.test(obj.id)
  ) {
    throw new CalendarQueryError("Invalid pagination cursor.");
  }
  return { createdAt: obj.createdAt, id: obj.id };
}

export function parseFilterOptionsQuery(params: URLSearchParams): void {
  toObject(params, []);
}

/** Filter-option search (design note §3): projects everywhere, members in accounts mode. */
export const FILTER_SEARCH_TYPES = ["projects", "members"] as const;
export type FilterSearchType = (typeof FILTER_SEARCH_TYPES)[number];
export const DEFAULT_FILTER_SEARCH_LIMIT = 25;
export const MAX_FILTER_SEARCH_LIMIT = 50;
export const MAX_FILTER_SEARCH_QUERY = 100;

export interface FilterSearchQuery {
  type: FilterSearchType;
  /** Trimmed, case-insensitive substring of the name; "" lists everything in order. */
  q: string;
  limit: number;
  cursor?: FilterSearchCursor;
}

export interface FilterSearchCursor {
  /** The sort key of the last row, exactly as the database produced it. */
  k: string;
  id: string;
}

export function parseFilterSearchQuery(params: URLSearchParams): FilterSearchQuery {
  const raw = toObject(params, ["type", "q", "limit", "cursor"]);
  const type = raw.type as FilterSearchType;
  if (!FILTER_SEARCH_TYPES.includes(type)) throw new CalendarQueryError("type must be 'projects' or 'members'.");
  const q = (raw.q ?? "").trim();
  if (q.length > MAX_FILTER_SEARCH_QUERY) {
    throw new CalendarQueryError(`Search text may be at most ${MAX_FILTER_SEARCH_QUERY} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(q)) throw new CalendarQueryError("Search text contains control characters.");
  const query: FilterSearchQuery = { type, q, limit: DEFAULT_FILTER_SEARCH_LIMIT };
  if (raw.limit !== undefined) {
    if (!/^[1-9][0-9]{0,2}$/.test(raw.limit) || Number(raw.limit) > MAX_FILTER_SEARCH_LIMIT) {
      throw new CalendarQueryError(`limit must be an integer between 1 and ${MAX_FILTER_SEARCH_LIMIT}.`);
    }
    query.limit = Number(raw.limit);
  }
  if (raw.cursor !== undefined) query.cursor = decodeFilterSearchCursor(raw.cursor);
  return query;
}

export function encodeFilterSearchCursor(cursor: FilterSearchCursor): string {
  return Buffer.from(JSON.stringify({ k: cursor.k, id: cursor.id })).toString("base64url");
}

/** Strict: bounded base64url JSON with exactly `k` (≤ 400 chars) and `id`. */
export function decodeFilterSearchCursor(cursor: string): FilterSearchCursor {
  if (cursor.length === 0 || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new CalendarQueryError("Invalid pagination cursor.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
  } catch {
    throw new CalendarQueryError("Invalid pagination cursor.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CalendarQueryError("Invalid pagination cursor.");
  }
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "id" ||
    keys[1] !== "k" ||
    typeof obj.k !== "string" ||
    obj.k.length > 400 ||
    typeof obj.id !== "string" ||
    !ID_PATTERN.test(obj.id)
  ) {
    throw new CalendarQueryError("Invalid pagination cursor.");
  }
  return { k: obj.k, id: obj.id };
}

/** Escapes LIKE wildcards so the search text is always matched literally. */
export function likePattern(q: string): string {
  return `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

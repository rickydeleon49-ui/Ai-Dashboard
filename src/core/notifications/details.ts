import type { NotificationCategory, NotificationDetails } from "./types";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function dateOrNull(value: unknown): string | null {
  return typeof value === "string" && DATE_ONLY.test(value) ? value : null;
}

/**
 * Reduces stored `details` to the allowlist for its category (design note §5).
 * Applied on every read, so an unexpected key in the database can never reach
 * a client.
 */
export function sanitizeNotificationDetails(
  category: NotificationCategory,
  raw: unknown,
): NotificationDetails {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  switch (category) {
    case "assignment":
      return { change: obj.change === "unassigned" ? "unassigned" : "assigned" };
    case "due_date":
      return { dueDate: dateOrNull(obj.dueDate), previousDueDate: dateOrNull(obj.previousDueDate) };
    default:
      return {};
  }
}

/** A stored timestamp as a calendar date (`YYYY-MM-DD`), or null. */
export function toDateOnly(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString().slice(0, 10) : null;
}

import { UUID_REGEX } from "@/core/tasks/mention-utils";

export const MAX_NOTIFICATION_CURSOR_LENGTH = 512;
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;
const CANONICAL_ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class InvalidNotificationCursorError extends Error {
  constructor(message = "Invalid pagination cursor.") {
    super(message);
    this.name = "InvalidNotificationCursorError";
  }
}

export interface NotificationCursor {
  createdAt: string;
  id: string;
}

export function encodeNotificationCursor(cursor: NotificationCursor): string {
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id })).toString("base64url");
}

/**
 * Strictly decodes a notification cursor: bounded length, base64url charset,
 * a JSON object with exactly `createdAt` (canonical millisecond ISO-8601, UTC)
 * and `id` (UUID). Anything else throws InvalidNotificationCursorError.
 */
export function decodeNotificationCursor(cursor: string): NotificationCursor {
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw new InvalidNotificationCursorError("Pagination cursor cannot be empty.");
  }
  if (cursor.length > MAX_NOTIFICATION_CURSOR_LENGTH) {
    throw new InvalidNotificationCursorError("Pagination cursor is too long.");
  }
  if (!BASE64URL_REGEX.test(cursor)) {
    throw new InvalidNotificationCursorError("Pagination cursor is not valid base64url.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
  } catch {
    throw new InvalidNotificationCursorError("Pagination cursor payload is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidNotificationCursorError("Pagination cursor payload must be an object.");
  }

  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (keys.length !== 2 || keys[0] !== "createdAt" || keys[1] !== "id") {
    throw new InvalidNotificationCursorError(
      "Pagination cursor must contain exactly 'createdAt' and 'id'.",
    );
  }
  if (typeof obj.id !== "string" || !UUID_REGEX.test(obj.id)) {
    throw new InvalidNotificationCursorError("Pagination cursor 'id' is invalid.");
  }
  if (typeof obj.createdAt !== "string" || !CANONICAL_ISO_MS.test(obj.createdAt)) {
    throw new InvalidNotificationCursorError("Pagination cursor 'createdAt' is invalid.");
  }
  const date = new Date(obj.createdAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== obj.createdAt) {
    throw new InvalidNotificationCursorError("Pagination cursor 'createdAt' is invalid.");
  }

  return { createdAt: obj.createdAt, id: obj.id };
}

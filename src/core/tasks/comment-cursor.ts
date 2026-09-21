import { InvalidPaginationError } from "./errors";

export const MAX_CURSOR_LENGTH = 1024;
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

export interface DecodedCommentCursor {
  createdAt: string;
  id: string;
}

/**
 * Encodes a verified cursor object to a standard base64url string.
 */
export function encodeCommentCursor(cursor: DecodedCommentCursor): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: cursor.createdAt,
      id: cursor.id,
    }),
  ).toString("base64url");
}

/**
 * Strictly decodes and validates a pagination cursor string.
 *
 * Enforces:
 * - String length bounds (1..1024)
 * - Strict base64url format
 * - Valid JSON payload
 * - Object with exactly 'createdAt' and 'id' fields
 * - Non-empty string id
 * - Valid, finite ISO date for createdAt
 *
 * Throws InvalidPaginationError on any violation.
 */
export function decodeCommentCursor(cursor: string): DecodedCommentCursor {
  if (typeof cursor !== "string") {
    throw new InvalidPaginationError("Pagination cursor must be a string.");
  }

  if (cursor.length === 0) {
    throw new InvalidPaginationError("Pagination cursor cannot be empty.");
  }

  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw new InvalidPaginationError(
      `Pagination cursor exceeds maximum allowed length of ${MAX_CURSOR_LENGTH} characters.`,
    );
  }

  if (!BASE64URL_REGEX.test(cursor)) {
    throw new InvalidPaginationError("Pagination cursor is not valid base64url.");
  }

  let jsonStr: string;
  try {
    const buf = Buffer.from(cursor, "base64url");
    if (buf.length === 0) {
      throw new Error("Empty buffer");
    }
    jsonStr = buf.toString("utf-8");
  } catch {
    throw new InvalidPaginationError("Failed to decode pagination cursor.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new InvalidPaginationError("Pagination cursor payload is not valid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidPaginationError("Pagination cursor payload must be an object.");
  }

  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 2 || !("createdAt" in obj) || !("id" in obj)) {
    throw new InvalidPaginationError(
      "Pagination cursor payload must contain exactly 'createdAt' and 'id' fields.",
    );
  }

  if (typeof obj.id !== "string" || obj.id.trim().length === 0) {
    throw new InvalidPaginationError(
      "Pagination cursor 'id' must be a non-empty string.",
    );
  }

  if (typeof obj.createdAt !== "string" || obj.createdAt.trim().length === 0) {
    throw new InvalidPaginationError(
      "Pagination cursor 'createdAt' must be a non-empty string.",
    );
  }

  const date = new Date(obj.createdAt);
  const time = date.getTime();
  if (!Number.isFinite(time) || isNaN(time)) {
    throw new InvalidPaginationError(
      "Pagination cursor 'createdAt' must be a valid ISO date.",
    );
  }

  return {
    createdAt: date.toISOString(),
    id: obj.id.trim(),
  };
}

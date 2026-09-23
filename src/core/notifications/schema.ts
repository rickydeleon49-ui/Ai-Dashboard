/**
 * Request validation for the collaboration inbox API (Release 2C.6).
 * Every schema is strict: unknown fields, unknown categories and non-boolean
 * values are rejected rather than ignored.
 */
import { z } from "zod";
import {
  DEFAULT_NOTIFICATION_PAGE_SIZE,
  MAX_NOTIFICATION_PAGE_SIZE,
  NOTIFICATION_FILTERS,
  NOTIFICATION_VIEWS,
} from "./types";

const STRICT_INTEGER = /^[1-9][0-9]{0,2}$/;

export const notificationListQuerySchema = z
  .object({
    view: z.enum(NOTIFICATION_VIEWS).default("inbox"),
    filter: z.enum(NOTIFICATION_FILTERS).default("all"),
    limit: z
      .string()
      .regex(STRICT_INTEGER, "limit must be an integer")
      .transform(Number)
      .refine((n) => n >= 1 && n <= MAX_NOTIFICATION_PAGE_SIZE, {
        message: `limit must be between 1 and ${MAX_NOTIFICATION_PAGE_SIZE}`,
      })
      .optional()
      .transform((n) => n ?? DEFAULT_NOTIFICATION_PAGE_SIZE),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

export const notificationStateChangeSchema = z
  .object({
    read: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.read !== undefined || v.archived !== undefined, {
    message: "Provide at least one of 'read' or 'archived'.",
  });

export const notificationPreferencesUpdateSchema = z
  .object({
    assignment: z.boolean().optional(),
    mention: z.boolean().optional(),
    comment: z.boolean().optional(),
    due_date: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((value) => value !== undefined), {
    message: "Provide at least one preference category.",
  });

/** Turns URLSearchParams into a plain object, rejecting repeated keys. */
export function searchParamsToObject(params: URLSearchParams): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.prototype.hasOwnProperty.call(out, key)) return null;
    out[key] = value;
  }
  return out;
}

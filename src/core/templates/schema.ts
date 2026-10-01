/**
 * Strict request schemas for Release 2D.3 templates. Unknown fields are
 * rejected at every level (`z.strictObject`), strings are trimmed and capped,
 * enumerations are closed. Structural rules that span items (references,
 * one-level subtasks, cycles, totals) live in `validate.ts`.
 */
import { z } from "zod";
import { isDateOnly } from "@/core/calendar/dates";
import { PROJECT_TYPES } from "@/core/projects/types";
import { TASK_PRIORITIES } from "@/core/tasks/types";
import {
  MAX_CHECKLIST_TEXT,
  MAX_DAY_OFFSET,
  MAX_DOCUMENT_CATEGORY,
  MAX_DOCUMENT_CONTENT,
  MAX_ITEM_TITLE,
  MAX_PROJECT_NAME,
  MAX_SHORT_DESCRIPTION,
  MAX_TASK_DESCRIPTION,
  MAX_TEMPLATE_CHECKLIST_ITEMS,
  MAX_TEMPLATE_DEPENDENCIES,
  MAX_TEMPLATE_DOCUMENTS,
  MAX_TEMPLATE_MILESTONES,
  MAX_TEMPLATE_NAME,
  MAX_TEMPLATE_TASKS,
  MIN_DAY_OFFSET,
} from "./limits";
import { TEMPLATE_KEY_PATTERN, TEMPLATE_PROJECT_STATUSES } from "./types";

const title = (max: number, label = "Title") => z.string().trim().min(1, `${label} is required`).max(max);

/** Empty strings become null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .default(null);

const key = z.string().regex(TEMPLATE_KEY_PATTERN, "Keys use lowercase letters, digits, - and _ (1–40 characters)");
const optionalKey = key.nullable().default(null);
const offset = z.number().int("Offsets are whole days").min(MIN_DAY_OFFSET).max(MAX_DAY_OFFSET).nullable().default(null);

export const templateContentSchema = z.strictObject({
  name: title(MAX_TEMPLATE_NAME, "Template name"),
  description: optionalText(MAX_SHORT_DESCRIPTION),
  project: z.strictObject({
    name: title(MAX_PROJECT_NAME, "Project name"),
    description: optionalText(MAX_SHORT_DESCRIPTION),
    type: z.enum(PROJECT_TYPES).default("software"),
    status: z.enum(TEMPLATE_PROJECT_STATUSES).default("idea"),
  }),
  milestones: z
    .array(
      z.strictObject({
        key,
        title: title(MAX_ITEM_TITLE),
        description: optionalText(MAX_SHORT_DESCRIPTION),
        targetOffset: offset,
      }),
    )
    .max(MAX_TEMPLATE_MILESTONES)
    .default([]),
  tasks: z
    .array(
      z.strictObject({
        key,
        title: title(MAX_ITEM_TITLE),
        description: optionalText(MAX_TASK_DESCRIPTION),
        priority: z.enum(TASK_PRIORITIES).default("medium"),
        dueOffset: offset,
        milestoneKey: optionalKey,
        parentKey: optionalKey,
      }),
    )
    .max(MAX_TEMPLATE_TASKS)
    .default([]),
  dependencies: z
    .array(z.strictObject({ taskKey: key, dependsOnKey: key }))
    .max(MAX_TEMPLATE_DEPENDENCIES)
    .default([]),
  checklist: z
    .array(z.strictObject({ taskKey: key, text: title(MAX_CHECKLIST_TEXT, "Checklist text") }))
    .max(MAX_TEMPLATE_CHECKLIST_ITEMS)
    .default([]),
  documents: z
    .array(
      z.strictObject({
        title: title(MAX_ITEM_TITLE),
        content: z.string().max(MAX_DOCUMENT_CONTENT).default(""),
        category: optionalText(MAX_DOCUMENT_CATEGORY),
        pinned: z.boolean().default(false),
      }),
    )
    .max(MAX_TEMPLATE_DOCUMENTS)
    .default([]),
});

/** Creating a template may send just a name; everything else defaults. */
export const templateCreateSchema = z.union([
  templateContentSchema,
  z.strictObject({ name: title(MAX_TEMPLATE_NAME, "Template name") }).transform((v) =>
    templateContentSchema.parse({ name: v.name, project: { name: v.name } }),
  ),
]);

const dateOnly = z.string().refine((v) => isDateOnly(v), "Must be a valid YYYY-MM-DD date between 1900-01-01 and 9999-12-31");

export const templateApplySchema = z.strictObject({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/, "Invalid request key"),
  startDate: dateOnly,
  name: title(MAX_PROJECT_NAME, "Project name").optional(),
});

/** Template ids are opaque; anything else is simply "not found". */
export const TEMPLATE_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/** Human-readable messages for a failed parse, keyed by path. */
export function zodIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.slice(0, 50).map((issue) => ({
    path: issue.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("").replace(/^\./, "") || "body",
    message: issue.message,
  }));
}

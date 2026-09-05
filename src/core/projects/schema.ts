/**
 * Runtime validation for everything crossing an application boundary
 * (forms, route handlers, imported integration payloads).
 *
 * The service layer validates once, at the edge, and trusts the data afterwards.
 */
import { z } from "zod";
import {
  PROJECT_SORTS,
  PROJECT_SOURCES,
  PROJECT_STATUSES,
  PROJECT_TYPES,
} from "./types";

/** Empty strings from HTML forms should become null, not "". */
const optionalText = z
  .string()
  .trim()
  .max(2000)
  .transform((v) => (v.length === 0 ? null : v))
  .nullable()
  .optional();

const optionalUrl = z
  .string()
  .trim()
  .transform((v) => (v.length === 0 ? null : v))
  .nullable()
  .optional()
  .refine(
    (v) => v === null || v === undefined || /^https?:\/\/\S+$/i.test(v),
    { message: "Must be a valid http(s) URL" },
  );

/** Accepts a comma-separated string or an array; normalises, dedupes, caps. */
function cleanTags(value: string | string[]): string[] {
  const raw = Array.isArray(value) ? value : value.split(",");
  const cleaned = raw
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && t.length <= 32);
  return Array.from(new Set(cleaned)).slice(0, 24);
}

const tagsInput = z.union([z.string(), z.array(z.string())]);

/** Create: absent tags mean "none". */
export const tagsSchema = tagsInput
  .optional()
  .transform((value) => (value === undefined ? [] : cleanTags(value)));

/** Update: absent tags mean "leave them alone", which is not the same thing. */
const tagsPatchSchema = tagsInput
  .optional()
  .transform((value) => (value === undefined ? undefined : cleanTags(value)));

/*
 * The field definitions, without defaults.
 *
 * Defaults belong to creation only. Applying them on update was a real bug:
 * `projectCreateSchema.partial()` keeps each field's `.default()`, so a PATCH
 * carrying one key still produced a full object with every other field at its
 * default — and the repository, seeing them as present, wrote them. Favouriting
 * a GitHub project therefore reset it to source "manual", type "software",
 * status "idea", and emptied the metadata holding its GitHub linkage.
 *
 * Keeping one field list and adding defaults only to the create schema means
 * the two can never drift apart again.
 */
const projectFields = {
  name: z.string().trim().min(1, "Name is required").max(160),
  description: optionalText,
  source: z.enum(PROJECT_SOURCES),
  type: z.enum(PROJECT_TYPES),
  status: z.enum(PROJECT_STATUSES),
  repositoryUrl: optionalUrl,
  projectUrl: optionalUrl,
  localPath: optionalText,
  notes: z.string().trim().max(20000).nullable().optional(),
  favorite: z.coerce.boolean(),
  archived: z.coerce.boolean(),
  externalId: optionalText,
  metadata: z.record(z.string(), z.unknown()),
};

export const projectCreateSchema = z.object({
  ...projectFields,
  source: projectFields.source.default("manual"),
  type: projectFields.type.default("software"),
  status: projectFields.status.default("idea"),
  favorite: projectFields.favorite.default(false),
  archived: projectFields.archived.default(false),
  metadata: projectFields.metadata.default({}),
  tags: tagsSchema,
});

/**
 * Update accepts any subset, and a key that was not sent stays unset — so the
 * repository only ever writes what the caller actually asked to change.
 */
export const projectUpdateSchema = z
  .object(projectFields)
  .partial()
  .extend({ tags: tagsPatchSchema });

export const projectQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  source: z.enum([...PROJECT_SOURCES, "all"]).optional(),
  status: z.enum([...PROJECT_STATUSES, "all"]).optional(),
  type: z.enum([...PROJECT_TYPES, "all"]).optional(),
  tag: z.string().trim().max(32).optional(),
  favorite: z.coerce.boolean().optional(),
  includeArchived: z.coerce.boolean().optional(),
  sort: z.enum(PROJECT_SORTS).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export type ProjectCreatePayload = z.input<typeof projectCreateSchema>;
export type ProjectUpdatePayload = z.input<typeof projectUpdateSchema>;

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

export const tagsSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (value === undefined) return [] as string[];
    const raw = Array.isArray(value) ? value : value.split(",");
    const cleaned = raw
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0 && t.length <= 32);
    return Array.from(new Set(cleaned)).slice(0, 24);
  });

export const projectCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(160),
  description: optionalText,
  source: z.enum(PROJECT_SOURCES).default("manual"),
  type: z.enum(PROJECT_TYPES).default("software"),
  status: z.enum(PROJECT_STATUSES).default("idea"),
  tags: tagsSchema,
  repositoryUrl: optionalUrl,
  projectUrl: optionalUrl,
  localPath: optionalText,
  notes: z.string().trim().max(20000).nullable().optional(),
  favorite: z.coerce.boolean().default(false),
  archived: z.coerce.boolean().default(false),
  externalId: optionalText,
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const projectUpdateSchema = projectCreateSchema.partial();

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

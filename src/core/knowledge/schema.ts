/**
 * Runtime validation for knowledge documents crossing an application
 * boundary — mirrors `core/tasks/schema.ts`'s own conventions exactly.
 * `projectId` is never part of these schemas: every create/list route
 * takes it from the URL (`/api/projects/[id]/knowledge`), never from the
 * request body.
 */
import { z } from "zod";

/** Empty strings from a form should become null, not "". */
const optionalCategory = z
  .string()
  .trim()
  .max(120)
  .transform((v) => (v.length === 0 ? null : v))
  .nullable()
  .optional();

const documentFields = {
  title: z.string().trim().min(1, "Title is required").max(200),
  content: z.string().max(50_000),
  category: optionalCategory,
  pinned: z.coerce.boolean(),
};

export const knowledgeDocumentCreateSchema = z.object({
  ...documentFields,
  content: documentFields.content.default(""),
  pinned: documentFields.pinned.default(false),
});

/** Update accepts any subset; a key that was not sent stays unset. */
export const knowledgeDocumentUpdateSchema = z.object(documentFields).partial();

export const knowledgeDocumentQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  category: z.string().trim().max(120).optional(),
});

import { z } from "zod";

/** Empty strings from HTML forms become null rather than "". */
const optional = z
  .string()
  .trim()
  .max(120)
  .transform((v) => (v.length === 0 ? null : v))
  .nullable()
  .optional();

export const promptCreateSchema = z.object({
  title: z.string().trim().min(1, "Give the prompt a name").max(160),
  body: z.string().trim().min(1, "A prompt needs some text").max(50_000),
  model: optional,
  category: optional,
  favorite: z.coerce.boolean().default(false),
});

export const promptUpdateSchema = promptCreateSchema.partial();

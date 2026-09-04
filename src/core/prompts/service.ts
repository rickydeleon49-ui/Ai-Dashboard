import "server-only";

import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { prompts } from "@/db/schema";
import { createId } from "@/lib/ids";
import type {
  Prompt,
  PromptCreateInput,
  PromptQuery,
  PromptUpdateInput,
} from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

export async function listPrompts(query: PromptQuery = {}): Promise<Prompt[]> {
  const conditions = [];

  if (query.favorite) conditions.push(eq(prompts.favorite, true));
  if (query.category) conditions.push(eq(prompts.category, query.category));

  if (query.search) {
    // Prompt bodies are the point of the library, so the search covers them —
    // finding a prompt by a phrase you remember from inside it matters more
    // than matching a title you may never have chosen well.
    const needle = `%${query.search.toLowerCase()}%`;
    conditions.push(
      or(
        like(sql`lower(${prompts.title})`, needle),
        like(sql`lower(${prompts.body})`, needle),
        like(sql`lower(coalesce(${prompts.category}, ''))`, needle),
        like(sql`lower(coalesce(${prompts.model}, ''))`, needle),
      )!,
    );
  }

  return db
    .select()
    .from(prompts)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(prompts.favorite), desc(prompts.updatedAt))
    .all();
}

export async function findPrompt(id: string): Promise<Prompt | null> {
  return db.select().from(prompts).where(eq(prompts.id, id)).get() ?? null;
}

export async function createPrompt(input: PromptCreateInput): Promise<Prompt> {
  const row: Prompt = {
    id: createId("pmt"),
    title: input.title,
    body: input.body,
    model: input.model ?? null,
    category: input.category ?? null,
    favorite: input.favorite ?? false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  db.insert(prompts).values(row).run();
  return row;
}

export async function updatePrompt(
  id: string,
  input: PromptUpdateInput,
): Promise<Prompt | null> {
  const existing = await findPrompt(id);
  if (!existing) return null;

  db.update(prompts)
    .set({ ...input, updatedAt: nowIso() })
    .where(eq(prompts.id, id))
    .run();

  return findPrompt(id);
}

export async function deletePrompt(id: string): Promise<boolean> {
  const existing = await findPrompt(id);
  if (!existing) return false;
  db.delete(prompts).where(eq(prompts.id, id)).run();
  return true;
}

/** Categories actually in use, with counts, for the filter row. */
export async function promptCategories(): Promise<
  { name: string; count: number }[]
> {
  return db
    .select({ name: prompts.category, count: sql<number>`count(*)` })
    .from(prompts)
    .where(sql`${prompts.category} is not null`)
    .groupBy(prompts.category)
    .orderBy(desc(sql`count(*)`))
    .all() as { name: string; count: number }[];
}

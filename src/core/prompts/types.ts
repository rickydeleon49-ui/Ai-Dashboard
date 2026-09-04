/**
 * Prompt library domain types.
 *
 * A prompt is text you keep rewriting: a review checklist, a commit-message
 * style, a debugging preamble. The library exists so that the good version is
 * findable rather than reconstructed from memory each time.
 */

/** Loose groupings, extend freely — stored as plain text, not an enum column. */
export const PROMPT_CATEGORIES = [
  "coding",
  "writing",
  "review",
  "research",
  "agents",
  "personal",
  "other",
] as const;

export type PromptCategory = (typeof PROMPT_CATEGORIES)[number];

export interface Prompt {
  id: string;
  title: string;
  body: string;
  /** Which model this was written for, when it matters. Free text. */
  model: string | null;
  category: string | null;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PromptQuery {
  search?: string;
  category?: string;
  favorite?: boolean;
}

/**
 * Only a title and body are required; the service fills the rest in. Optional
 * fields are genuinely optional here rather than nullable-but-required, so a
 * validated form payload can be passed straight through.
 */
export interface PromptCreateInput {
  title: string;
  body: string;
  model?: string | null;
  category?: string | null;
  favorite?: boolean;
}

export type PromptUpdateInput = Partial<PromptCreateInput>;

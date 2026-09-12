/**
 * Core planning domain types (Phase 2, release B): the project knowledge
 * base — a flat list of documents scoped to one project. Mirrors
 * `core/tasks/types.ts`'s own conventions exactly. No folders/hierarchy,
 * no markdown rendering, no version history in this first slice — see
 * the release plan's "explicitly deferred" section.
 */

export interface KnowledgeDocument {
  id: string;
  projectId: string;
  title: string;
  /** Plain text — rendered with `whitespace-pre-wrap`, not parsed as markdown. */
  content: string;
  /** Free text, same convention as `Prompt.category` — not an enum column. */
  category: string | null;
  /** Keeps key documents at the top of the list, same convention as `Prompt.favorite`. */
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export type KnowledgeDocumentCreateInput = Partial<Omit<KnowledgeDocument, "id">> & {
  projectId: string;
  title: string;
};

/** Fields a caller may change. `projectId` and `createdAt` are immutable. */
export type KnowledgeDocumentUpdateInput = Partial<
  Omit<KnowledgeDocument, "id" | "projectId" | "createdAt">
>;

export interface KnowledgeDocumentQuery {
  /** Matches title, content or category — see the repository's own search comment. */
  search?: string;
  category?: string;
}

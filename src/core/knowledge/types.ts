/**
 * Core planning domain types (Phase 2, release B): the project knowledge
 * base — a flat list of documents scoped to one project. Mirrors
 * `core/tasks/types.ts`'s own conventions exactly. No folders/hierarchy
 * and no version history yet. Content is Markdown, rendered safely since
 * Release 2E.1 (`core/knowledge/markdown.ts`).
 */

export interface KnowledgeDocument {
  id: string;
  projectId: string;
  title: string;
  /**
   * Markdown source, stored exactly as written. Rendered by
   * `components/knowledge/markdown-view.tsx`; never converted in place.
   */
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

/** A plain listing. Searching is a separate operation (`KnowledgeDocumentRepository.search`). */
export interface KnowledgeDocumentQuery {
  category?: string;
}

export interface KnowledgeSearchQuery {
  /**
   * Matches the title, category or visible document text (not raw Markdown
   * syntax, link destinations or HTML) — see `buildKnowledgeSearchText`.
   */
  search: string;
  category?: string;
}

/**
 * Whether a search could see every document in the project. Documents whose
 * derived search text is stale (written before Release 2E.1, or by an older
 * build) are re-derived a bounded batch per search; until none remain the
 * search is incomplete and says so — see `core/knowledge/search-index.ts`.
 */
export interface KnowledgeSearchIndexState {
  complete: boolean;
  /** Documents in the project whose search text is still stale after this request. */
  pending: number;
  /** Documents this request re-derived. */
  indexedNow: number;
}

export interface KnowledgeSearchResult {
  documents: KnowledgeDocument[];
  index: KnowledgeSearchIndexState;
}

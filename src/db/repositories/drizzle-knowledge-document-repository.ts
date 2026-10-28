import { and, count, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "../client";
import { knowledgeDocuments } from "../schema";
import { LOCAL_WORKSPACE_ID } from "./project-repository";
import type { KnowledgeDocumentRepository } from "./knowledge-document-repository";
import type {
  KnowledgeDocument,
  KnowledgeDocumentCreateInput,
  KnowledgeDocumentQuery,
  KnowledgeDocumentUpdateInput,
  KnowledgeSearchQuery,
  KnowledgeSearchResult,
} from "@/core/knowledge/types";
import { SEARCH_INDEX_BATCH_ROWS, chooseSearchIndexBatch } from "@/core/knowledge/search-index";
import { buildKnowledgeSearchText, searchLikePattern } from "@/core/knowledge/markdown";
import { createId } from "@/lib/ids";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The columns a caller sees. The derived search columns are deliberately not
 * selected: they can be as large as the content and nothing outside search
 * needs them.
 */
const documentColumns = {
  id: knowledgeDocuments.id,
  projectId: knowledgeDocuments.projectId,
  title: knowledgeDocuments.title,
  content: knowledgeDocuments.content,
  category: knowledgeDocuments.category,
  pinned: knowledgeDocuments.pinned,
  createdAt: knowledgeDocuments.createdAt,
  updatedAt: knowledgeDocuments.updatedAt,
};

type DocumentRow = {
  id: string;
  projectId: string;
  title: string;
  content: string;
  category: string | null;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};

function toDomain(row: DocumentRow): KnowledgeDocument {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    content: row.content,
    category: row.category,
    pinned: row.pinned,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** See `DrizzleProjectRepository`'s own copy of this check for the reasoning. */
function assertLocalWorkspace(workspaceId: string): void {
  if (workspaceId !== LOCAL_WORKSPACE_ID) {
    throw new Error(
      `DrizzleKnowledgeDocumentRepository (SQLite) only serves "${LOCAL_WORKSPACE_ID}"; got "${workspaceId}". ` +
        "Hosted multi-user mode must use PostgresKnowledgeDocumentRepository instead.",
    );
  }
}

/** A row whose derived search text is missing or was derived for a different `updated_at`. */
const isStale = or(
  isNull(knowledgeDocuments.searchText),
  sql`${knowledgeDocuments.searchIndexedAt} IS NOT ${knowledgeDocuments.updatedAt}`,
)!;

/**
 * The exact complement of {@link isStale}: derived text that matches the row
 * as it is now. Search results require it, because a stale key need not be
 * NULL — an older build can change a row's content and `updated_at` and leave
 * its previous `search_text` behind, which would still match removed words.
 * SQLite's `IS` is the null-safe equality.
 */
const isFresh = and(
  isNotNull(knowledgeDocuments.searchText),
  sql`${knowledgeDocuments.searchIndexedAt} IS ${knowledgeDocuments.updatedAt}`,
)!;

/** Stored size of the text a re-derivation parses, in bytes (SQLite stores TEXT as UTF-8). */
const storedBytes = sql<number>`length(CAST(${knowledgeDocuments.title} AS BLOB)) + coalesce(length(CAST(${knowledgeDocuments.category} AS BLOB)), 0) + length(CAST(${knowledgeDocuments.content} AS BLOB))`;

/**
 * Re-derives ONE bounded batch of this project's stale `search_text` — rows
 * written before Release 2E.1, or by an older build after a rollback — and
 * returns how many it re-derived. See `core/knowledge/search-index.ts` for the
 * budgets and why work is never looped to completion here.
 *
 * Only the candidates' ids and sizes are read until the batch is chosen; only
 * the chosen bodies are loaded. The batch is written in one short transaction.
 * Touches only the derived columns: `updated_at`, the source, pinning and the
 * list order are unchanged. Each write is conditional on the title, category
 * and content still being what was read.
 *
 * Synchronous from first read to last write (better-sqlite3, no `await`), so
 * two searches in this process can never interleave and redo the same rows.
 */
function refreshStaleSearchTextBatch(projectId: string): number {
  const candidates = db
    .select({ id: knowledgeDocuments.id, bytes: storedBytes })
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.projectId, projectId), isStale))
    .orderBy(knowledgeDocuments.id)
    .limit(SEARCH_INDEX_BATCH_ROWS)
    .all();
  const ids = chooseSearchIndexBatch(candidates);
  if (ids.length === 0) return 0;

  const rows = db
    .select({
      id: knowledgeDocuments.id,
      title: knowledgeDocuments.title,
      category: knowledgeDocuments.category,
      content: knowledgeDocuments.content,
    })
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.projectId, projectId), inArray(knowledgeDocuments.id, ids)))
    .all();

  let indexed = 0;
  db.transaction((tx) => {
    for (const row of rows) {
      const result = tx
        .update(knowledgeDocuments)
        .set({
          searchText: buildKnowledgeSearchText(row),
          searchIndexedAt: sql`${knowledgeDocuments.updatedAt}`,
        })
        .where(
          and(
            eq(knowledgeDocuments.id, row.id),
            eq(knowledgeDocuments.title, row.title),
            eq(knowledgeDocuments.content, row.content),
            sql`${knowledgeDocuments.category} IS ${row.category}`,
          ),
        )
        .run();
      indexed += result.changes;
    }
  });
  return indexed;
}

/** SQLite-backed implementation of {@link KnowledgeDocumentRepository}. */
export class DrizzleKnowledgeDocumentRepository implements KnowledgeDocumentRepository {
  async list(
    workspaceId: string,
    projectId: string,
    query: KnowledgeDocumentQuery = {},
  ): Promise<KnowledgeDocument[]> {
    assertLocalWorkspace(workspaceId);
    const conditions = [eq(knowledgeDocuments.projectId, projectId)];
    if (query.category) {
      conditions.push(eq(knowledgeDocuments.category, query.category));
    }

    const rows = db
      .select(documentColumns)
      .from(knowledgeDocuments)
      .where(and(...conditions))
      .orderBy(desc(knowledgeDocuments.pinned), desc(knowledgeDocuments.updatedAt))
      .all();
    return rows.map(toDomain);
  }

  /**
   * Search covers the title, category and the document's visible text — not
   * Markdown syntax, link destinations or raw HTML — through the derived
   * column. Both backends compare the same normalized key with the same
   * escaped pattern, so they match the same documents. Only rows whose
   * derived text is fresh can match — a stale key, NULL or left over from an
   * older version, is never searched — so the result says how many stale rows
   * remain rather than claiming to be complete.
   */
  async search(
    workspaceId: string,
    projectId: string,
    query: KnowledgeSearchQuery,
  ): Promise<KnowledgeSearchResult> {
    assertLocalWorkspace(workspaceId);
    const indexedNow = refreshStaleSearchTextBatch(projectId);
    const pending =
      db
        .select({ n: count() })
        .from(knowledgeDocuments)
        .where(and(eq(knowledgeDocuments.projectId, projectId), isStale))
        .get()?.n ?? 0;

    const conditions = [
      eq(knowledgeDocuments.projectId, projectId),
      isFresh,
      sql`${knowledgeDocuments.searchText} LIKE ${searchLikePattern(query.search)} ESCAPE '\\'`,
    ];
    if (query.category) {
      conditions.push(eq(knowledgeDocuments.category, query.category));
    }
    const rows = db
      .select(documentColumns)
      .from(knowledgeDocuments)
      .where(and(...conditions))
      .orderBy(desc(knowledgeDocuments.pinned), desc(knowledgeDocuments.updatedAt))
      .all();
    return { documents: rows.map(toDomain), index: { complete: pending === 0, pending, indexedNow } };
  }

  async categoryCounts(workspaceId: string, projectId: string): Promise<{ name: string; count: number }[]> {
    assertLocalWorkspace(workspaceId);
    const rows = db
      .select({ name: knowledgeDocuments.category, count: count() })
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.projectId, projectId), isNotNull(knowledgeDocuments.category)))
      .groupBy(knowledgeDocuments.category)
      .orderBy(desc(count()), knowledgeDocuments.category)
      .all();
    return rows.map((row) => ({ name: row.name!, count: row.count }));
  }

  async findById(workspaceId: string, id: string): Promise<KnowledgeDocument | null> {
    assertLocalWorkspace(workspaceId);
    const row = db
      .select(documentColumns)
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, id))
      .get();
    return row ? toDomain(row) : null;
  }

  async create(
    workspaceId: string,
    input: KnowledgeDocumentCreateInput,
  ): Promise<KnowledgeDocument> {
    assertLocalWorkspace(workspaceId);
    const id = createId("kdoc");
    const timestamp = nowIso();
    const content = input.content ?? "";
    const category = input.category ?? null;
    const updatedAt = input.updatedAt ?? timestamp;

    db.insert(knowledgeDocuments)
      .values({
        id,
        projectId: input.projectId,
        title: input.title,
        content,
        category,
        pinned: input.pinned ?? false,
        createdAt: input.createdAt ?? timestamp,
        updatedAt,
        searchText: buildKnowledgeSearchText({ title: input.title, category, content }),
        searchIndexedAt: updatedAt,
      })
      .run();

    const created = await this.findById(workspaceId, id);
    if (!created) throw new Error("Failed to read back created knowledge document");
    return created;
  }

  async update(
    workspaceId: string,
    id: string,
    input: KnowledgeDocumentUpdateInput,
  ): Promise<KnowledgeDocument | null> {
    assertLocalWorkspace(workspaceId);
    const existing = db
      .select(documentColumns)
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, id))
      .get();
    if (!existing) return null;

    const updatedAt = nowIso();
    const next = {
      title: input.title ?? existing.title,
      content: input.content ?? existing.content,
      category: input.category !== undefined ? input.category : existing.category,
    };
    const patch: Partial<typeof knowledgeDocuments.$inferInsert> = {
      updatedAt,
      searchText: buildKnowledgeSearchText(next),
      searchIndexedAt: updatedAt,
    };
    if (input.title !== undefined) patch.title = input.title;
    if (input.content !== undefined) patch.content = input.content;
    if (input.category !== undefined) patch.category = input.category;
    if (input.pinned !== undefined) patch.pinned = input.pinned;

    db.update(knowledgeDocuments).set(patch).where(eq(knowledgeDocuments.id, id)).run();
    return this.findById(workspaceId, id);
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    assertLocalWorkspace(workspaceId);
    const existing = db
      .select({ id: knowledgeDocuments.id })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, id))
      .get();
    if (!existing) return false;
    db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, id)).run();
    return true;
  }
}

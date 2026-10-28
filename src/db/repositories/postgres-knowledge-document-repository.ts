import "server-only";

import { and, count, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getPgDb } from "../pg-client";
import { knowledgeDocuments } from "../schema.pg";
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
import type { KnowledgeDocumentRepository } from "./knowledge-document-repository";

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
  createdAt: Date;
  updatedAt: Date;
};

function toDomain(row: DocumentRow): KnowledgeDocument {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    content: row.content,
    category: row.category,
    pinned: row.pinned,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A row whose derived search text is missing or was derived for a different `updated_at`. */
const isStale = or(
  isNull(knowledgeDocuments.searchText),
  sql`${knowledgeDocuments.searchIndexedAt} IS DISTINCT FROM ${knowledgeDocuments.updatedAt}`,
)!;

/**
 * The exact complement of {@link isStale}: derived text that matches the row
 * as it is now. Search results require it — a stale key need not be NULL (see
 * the SQLite repository). `IS NOT DISTINCT FROM` is the null-safe equality.
 */
const isFresh = and(
  isNotNull(knowledgeDocuments.searchText),
  sql`${knowledgeDocuments.searchIndexedAt} IS NOT DISTINCT FROM ${knowledgeDocuments.updatedAt}`,
)!;

/** Stored size of the text a re-derivation parses, in bytes. */
const storedBytes = sql<number>`octet_length(${knowledgeDocuments.title}) + coalesce(octet_length(${knowledgeDocuments.category}), 0) + octet_length(${knowledgeDocuments.content})`.mapWith(Number);

/**
 * Postgres-backed, genuinely workspace-scoped implementation of
 * {@link KnowledgeDocumentRepository} — hosted multi-user mode. Mirrors
 * `DrizzleKnowledgeDocumentRepository`'s (SQLite) behavior closely so the
 * two are interchangeable from a caller's perspective; every query here
 * additionally filters on `workspaceId`. Search compares the same derived,
 * normalized `search_text` with the same escaped `LIKE` pattern as SQLite, so
 * both backends return the same documents for the same query.
 */
export class PostgresKnowledgeDocumentRepository implements KnowledgeDocumentRepository {
  /**
   * Re-derives ONE bounded batch of this project's stale `search_text` in this
   * workspace and returns how many rows it re-derived — see
   * `core/knowledge/search-index.ts` for the budgets, and the SQLite
   * repository's copy for what is and is not touched.
   *
   * One short transaction: the candidates are claimed with
   * `FOR UPDATE SKIP LOCKED`, so concurrent searches take different rows
   * instead of redoing the same ones, and an in-flight `update()` (which locks
   * its row) is skipped rather than waited for — it writes fresh text itself.
   * Only the claimed candidates' sizes are read until the batch is chosen; only
   * the chosen bodies are loaded. Writes stay conditional on the source still
   * being what was read.
   */
  private async refreshStaleSearchTextBatch(workspaceId: string, projectId: string): Promise<number> {
    const db = getPgDb();
    return db.transaction(async (tx) => {
      const candidates = await tx
        .select({ id: knowledgeDocuments.id, bytes: storedBytes })
        .from(knowledgeDocuments)
        .where(
          and(
            eq(knowledgeDocuments.workspaceId, workspaceId),
            eq(knowledgeDocuments.projectId, projectId),
            isStale,
          ),
        )
        .orderBy(knowledgeDocuments.id)
        .limit(SEARCH_INDEX_BATCH_ROWS)
        .for("update", { skipLocked: true });
      const ids = chooseSearchIndexBatch(candidates);
      if (ids.length === 0) return 0;

      const rows = await tx
        .select({
          id: knowledgeDocuments.id,
          title: knowledgeDocuments.title,
          category: knowledgeDocuments.category,
          content: knowledgeDocuments.content,
        })
        .from(knowledgeDocuments)
        .where(and(eq(knowledgeDocuments.workspaceId, workspaceId), inArray(knowledgeDocuments.id, ids)));

      let indexed = 0;
      for (const row of rows) {
        const updated = await tx
          .update(knowledgeDocuments)
          .set({
            searchText: buildKnowledgeSearchText(row),
            searchIndexedAt: sql`${knowledgeDocuments.updatedAt}`,
          })
          .where(
            and(
              eq(knowledgeDocuments.workspaceId, workspaceId),
              eq(knowledgeDocuments.id, row.id),
              eq(knowledgeDocuments.title, row.title),
              eq(knowledgeDocuments.content, row.content),
              sql`${knowledgeDocuments.category} IS NOT DISTINCT FROM ${row.category}`,
            ),
          )
          .returning({ id: knowledgeDocuments.id });
        indexed += updated.length;
      }
      return indexed;
    });
  }

  async list(
    workspaceId: string,
    projectId: string,
    query: KnowledgeDocumentQuery = {},
  ): Promise<KnowledgeDocument[]> {
    const db = getPgDb();
    const conditions = [
      eq(knowledgeDocuments.workspaceId, workspaceId),
      eq(knowledgeDocuments.projectId, projectId),
    ];
    if (query.category) {
      conditions.push(eq(knowledgeDocuments.category, query.category));
    }

    const rows = await db
      .select(documentColumns)
      .from(knowledgeDocuments)
      .where(and(...conditions))
      .orderBy(desc(knowledgeDocuments.pinned), desc(knowledgeDocuments.updatedAt));
    return rows.map(toDomain);
  }

  async search(
    workspaceId: string,
    projectId: string,
    query: KnowledgeSearchQuery,
  ): Promise<KnowledgeSearchResult> {
    const db = getPgDb();
    const indexedNow = await this.refreshStaleSearchTextBatch(workspaceId, projectId);
    const [pendingRow] = await db
      .select({ n: count() })
      .from(knowledgeDocuments)
      .where(
        and(eq(knowledgeDocuments.workspaceId, workspaceId), eq(knowledgeDocuments.projectId, projectId), isStale),
      );
    const pending = pendingRow?.n ?? 0;

    const conditions = [
      eq(knowledgeDocuments.workspaceId, workspaceId),
      eq(knowledgeDocuments.projectId, projectId),
      isFresh,
      sql`${knowledgeDocuments.searchText} LIKE ${searchLikePattern(query.search)} ESCAPE '\\'`,
    ];
    if (query.category) {
      conditions.push(eq(knowledgeDocuments.category, query.category));
    }
    const rows = await db
      .select(documentColumns)
      .from(knowledgeDocuments)
      .where(and(...conditions))
      .orderBy(desc(knowledgeDocuments.pinned), desc(knowledgeDocuments.updatedAt));
    return { documents: rows.map(toDomain), index: { complete: pending === 0, pending, indexedNow } };
  }

  async categoryCounts(workspaceId: string, projectId: string): Promise<{ name: string; count: number }[]> {
    const db = getPgDb();
    const rows = await db
      .select({ name: knowledgeDocuments.category, count: count() })
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.workspaceId, workspaceId),
          eq(knowledgeDocuments.projectId, projectId),
          isNotNull(knowledgeDocuments.category),
        ),
      )
      .groupBy(knowledgeDocuments.category)
      .orderBy(desc(count()), knowledgeDocuments.category);
    return rows.map((row) => ({ name: row.name!, count: row.count }));
  }

  async findById(workspaceId: string, id: string): Promise<KnowledgeDocument | null> {
    const db = getPgDb();
    const [row] = await db
      .select(documentColumns)
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.workspaceId, workspaceId), eq(knowledgeDocuments.id, id)))
      .limit(1);
    return row ? toDomain(row) : null;
  }

  async create(
    workspaceId: string,
    input: KnowledgeDocumentCreateInput,
  ): Promise<KnowledgeDocument> {
    const db = getPgDb();
    const id = createId("kdoc");
    const now = new Date();
    const content = input.content ?? "";
    const category = input.category ?? null;
    const updatedAt = input.updatedAt ? new Date(input.updatedAt) : now;

    await db.insert(knowledgeDocuments).values({
      id,
      workspaceId,
      projectId: input.projectId,
      title: input.title,
      content,
      category,
      pinned: input.pinned ?? false,
      createdAt: input.createdAt ? new Date(input.createdAt) : now,
      updatedAt,
      searchText: buildKnowledgeSearchText({ title: input.title, category, content }),
      searchIndexedAt: updatedAt,
    });

    const created = await this.findById(workspaceId, id);
    if (!created) throw new Error("Failed to read back created knowledge document");
    return created;
  }

  async update(
    workspaceId: string,
    id: string,
    input: KnowledgeDocumentUpdateInput,
  ): Promise<KnowledgeDocument | null> {
    const db = getPgDb();
    // The search text depends on title, category and content together, so
    // two concurrent partial updates must not each derive it from a row the
    // other is changing. Locking the row serializes them.
    const updated = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select(documentColumns)
        .from(knowledgeDocuments)
        .where(and(eq(knowledgeDocuments.workspaceId, workspaceId), eq(knowledgeDocuments.id, id)))
        .limit(1)
        .for("update");
      if (!existing) return false;

      const updatedAt = new Date();
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

      await tx
        .update(knowledgeDocuments)
        .set(patch)
        .where(and(eq(knowledgeDocuments.workspaceId, workspaceId), eq(knowledgeDocuments.id, id)));
      return true;
    });
    if (!updated) return null;
    return this.findById(workspaceId, id);
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    const db = getPgDb();
    const [existing] = await db
      .select({ id: knowledgeDocuments.id })
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.workspaceId, workspaceId), eq(knowledgeDocuments.id, id)))
      .limit(1);
    if (!existing) return false;
    await db
      .delete(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.workspaceId, workspaceId), eq(knowledgeDocuments.id, id)));
    return true;
  }
}

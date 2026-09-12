import "server-only";

import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { getPgDb } from "../pg-client";
import { knowledgeDocuments } from "../schema.pg";
import type {
  KnowledgeDocument,
  KnowledgeDocumentCreateInput,
  KnowledgeDocumentQuery,
  KnowledgeDocumentUpdateInput,
} from "@/core/knowledge/types";
import { createId } from "@/lib/ids";
import type { KnowledgeDocumentRepository } from "./knowledge-document-repository";

type KnowledgeDocumentRow = typeof knowledgeDocuments.$inferSelect;

function toDomain(row: KnowledgeDocumentRow): KnowledgeDocument {
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

/**
 * Postgres-backed, genuinely workspace-scoped implementation of
 * {@link KnowledgeDocumentRepository} — hosted multi-user mode. Mirrors
 * `DrizzleKnowledgeDocumentRepository`'s (SQLite) behavior closely so the
 * two are interchangeable from a caller's perspective; every query here
 * additionally filters on `workspaceId`. Search uses Postgres's native
 * case-insensitive `ilike` rather than SQLite's `lower(...) like` idiom.
 */
export class PostgresKnowledgeDocumentRepository implements KnowledgeDocumentRepository {
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
    if (query.search) {
      const needle = `%${query.search}%`;
      conditions.push(
        or(
          ilike(knowledgeDocuments.title, needle),
          ilike(knowledgeDocuments.content, needle),
          ilike(sql`coalesce(${knowledgeDocuments.category}, '')`, needle),
        )!,
      );
    }

    const rows = await db
      .select()
      .from(knowledgeDocuments)
      .where(and(...conditions))
      .orderBy(desc(knowledgeDocuments.pinned), desc(knowledgeDocuments.updatedAt));
    return rows.map(toDomain);
  }

  async findById(workspaceId: string, id: string): Promise<KnowledgeDocument | null> {
    const db = getPgDb();
    const [row] = await db
      .select()
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

    await db.insert(knowledgeDocuments).values({
      id,
      workspaceId,
      projectId: input.projectId,
      title: input.title,
      content: input.content ?? "",
      category: input.category ?? null,
      pinned: input.pinned ?? false,
      createdAt: input.createdAt ? new Date(input.createdAt) : now,
      updatedAt: input.updatedAt ? new Date(input.updatedAt) : now,
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
    const [existing] = await db
      .select()
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.workspaceId, workspaceId), eq(knowledgeDocuments.id, id)))
      .limit(1);
    if (!existing) return null;

    const patch: Partial<typeof knowledgeDocuments.$inferInsert> = { updatedAt: new Date() };
    if (input.title !== undefined) patch.title = input.title;
    if (input.content !== undefined) patch.content = input.content;
    if (input.category !== undefined) patch.category = input.category;
    if (input.pinned !== undefined) patch.pinned = input.pinned;

    await db
      .update(knowledgeDocuments)
      .set(patch)
      .where(and(eq(knowledgeDocuments.workspaceId, workspaceId), eq(knowledgeDocuments.id, id)));
    return this.findById(workspaceId, id);
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    const db = getPgDb();
    const [existing] = await db
      .select()
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

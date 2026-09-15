import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { db } from "../client";
import { knowledgeDocuments } from "../schema";
import type { KnowledgeDocumentRow } from "../schema";
import { LOCAL_WORKSPACE_ID } from "./project-repository";
import type { KnowledgeDocumentRepository } from "./knowledge-document-repository";
import type {
  KnowledgeDocument,
  KnowledgeDocumentCreateInput,
  KnowledgeDocumentQuery,
  KnowledgeDocumentUpdateInput,
} from "@/core/knowledge/types";
import { createId } from "@/lib/ids";

function nowIso(): string {
  return new Date().toISOString();
}

function toDomain(row: KnowledgeDocumentRow): KnowledgeDocument {
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
    if (query.search) {
      // The content is the point of a knowledge base entry, so search covers
      // it — same reasoning as core/prompts/service.ts's own search.
      const needle = `%${query.search.toLowerCase()}%`;
      conditions.push(
        or(
          like(sql`lower(${knowledgeDocuments.title})`, needle),
          like(sql`lower(${knowledgeDocuments.content})`, needle),
          like(sql`lower(coalesce(${knowledgeDocuments.category}, ''))`, needle),
        )!,
      );
    }

    const rows = db
      .select()
      .from(knowledgeDocuments)
      .where(and(...conditions))
      .orderBy(desc(knowledgeDocuments.pinned), desc(knowledgeDocuments.updatedAt))
      .all();
    return rows.map(toDomain);
  }

  async findById(workspaceId: string, id: string): Promise<KnowledgeDocument | null> {
    assertLocalWorkspace(workspaceId);
    const row = db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, id)).get();
    return row ? toDomain(row) : null;
  }

  async create(
    workspaceId: string,
    input: KnowledgeDocumentCreateInput,
  ): Promise<KnowledgeDocument> {
    assertLocalWorkspace(workspaceId);
    const id = createId("kdoc");
    const timestamp = nowIso();

    db.insert(knowledgeDocuments)
      .values({
        id,
        projectId: input.projectId,
        title: input.title,
        content: input.content ?? "",
        category: input.category ?? null,
        pinned: input.pinned ?? false,
        createdAt: input.createdAt ?? timestamp,
        updatedAt: input.updatedAt ?? timestamp,
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
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, id))
      .get();
    if (!existing) return null;

    const patch: Partial<KnowledgeDocumentRow> = { updatedAt: nowIso() };
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
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, id))
      .get();
    if (!existing) return false;
    db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, id)).run();
    return true;
  }
}

/**
 * The persistence contract for knowledge documents — mirrors
 * `./milestone-repository.ts`'s own shape and reasoning exactly. Everything
 * above this line depends only on this interface, never on Drizzle or a
 * specific database directly.
 */
import type {
  KnowledgeDocument,
  KnowledgeDocumentCreateInput,
  KnowledgeDocumentQuery,
  KnowledgeDocumentUpdateInput,
} from "@/core/knowledge/types";

/**
 * `workspaceId` is a mandatory first parameter on every method, matching
 * `MilestoneRepository`/`ProjectRepository` — explicit and grep-able,
 * impossible to silently forget at a call site.
 * `DrizzleKnowledgeDocumentRepository` (SQLite) only ever accepts
 * `LOCAL_WORKSPACE_ID` (re-exported from `./project-repository`) and throws
 * on anything else; `PostgresKnowledgeDocumentRepository` genuinely scopes
 * every query to it.
 */
export interface KnowledgeDocumentRepository {
  list(
    workspaceId: string,
    projectId: string,
    query?: KnowledgeDocumentQuery,
  ): Promise<KnowledgeDocument[]>;
  findById(workspaceId: string, id: string): Promise<KnowledgeDocument | null>;
  create(workspaceId: string, input: KnowledgeDocumentCreateInput): Promise<KnowledgeDocument>;
  update(
    workspaceId: string,
    id: string,
    input: KnowledgeDocumentUpdateInput,
  ): Promise<KnowledgeDocument | null>;
  delete(workspaceId: string, id: string): Promise<boolean>;
}

import { NextResponse, type NextRequest } from "next/server";
import { knowledgeDocumentRepository, projectRepository } from "@/db/repositories";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { knowledgeDocumentCreateSchema, knowledgeDocumentQuerySchema } from "@/core/knowledge/schema";
import {
  resolveWorkspaceAndUserForRequest,
  resolveWorkspaceIdForRequest,
} from "@/core/workspaces/current-workspace";
import { AuthorizationError, authorizationErrorResponse, requireRole } from "@/core/workspaces/authorization";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function workspaceRequiredResponse(): NextResponse {
  return NextResponse.json(
    { error: "Sign-in required." },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

function projectNotFoundResponse(): NextResponse {
  return NextResponse.json({ error: "Project not found" }, { status: 404 });
}

/** GET /api/projects/:id/knowledge */
export async function GET(request: NextRequest, { params }: Context) {
  ensureDatabaseReady();
  const workspaceId = await resolveWorkspaceIdForRequest(request);
  if (!workspaceId) return workspaceRequiredResponse();

  const { id } = await params;
  const project = await projectRepository.findById(workspaceId, id);
  if (!project) return projectNotFoundResponse();

  const url = new URL(request.url);
  const parsed = knowledgeDocumentQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { search, category } = parsed.data;
  if (search) {
    // A search re-derives at most one bounded batch of stale search text and
    // says whether every document could be searched. `searchIndex.complete:
    // false` means older documents are still pending: these results may be
    // missing matches, and repeating the request continues the indexing.
    const result = await knowledgeDocumentRepository.search(workspaceId, id, { search, category });
    return NextResponse.json({
      documents: result.documents,
      searchIndex: { complete: result.index.complete, pending: result.index.pending },
    });
  }

  const documents = await knowledgeDocumentRepository.list(workspaceId, id, { category });
  return NextResponse.json({ documents });
}

/**
 * POST /api/projects/:id/knowledge — a write, so membership alone (what
 * `resolveWorkspaceIdForRequest` checks) is not enough; see the sibling
 * Projects route for the same reasoning.
 */
export async function POST(request: NextRequest, { params }: Context) {
  ensureDatabaseReady();
  const resolved = await resolveWorkspaceAndUserForRequest(request);
  if (!resolved) return workspaceRequiredResponse();
  const { workspaceId, userId } = resolved;

  if (userId) {
    try {
      await requireRole(workspaceId, userId, "member");
    } catch (error) {
      if (error instanceof AuthorizationError) return authorizationErrorResponse(error);
      throw error;
    }
  }

  const { id } = await params;
  const project = await projectRepository.findById(workspaceId, id);
  if (!project) return projectNotFoundResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = knowledgeDocumentCreateSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid document", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const document = await knowledgeDocumentRepository.create(workspaceId, { ...parsed.data, projectId: id });
  return NextResponse.json({ document }, { status: 201 });
}

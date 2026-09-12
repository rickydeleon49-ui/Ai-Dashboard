import { NextResponse, type NextRequest } from "next/server";
import { knowledgeDocumentRepository } from "@/db/repositories";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { knowledgeDocumentUpdateSchema } from "@/core/knowledge/schema";
import {
  resolveWorkspaceAndUserForRequest,
  resolveWorkspaceIdForRequest,
} from "@/core/workspaces/current-workspace";
import { AuthorizationError, authorizationErrorResponse, requireRole } from "@/core/workspaces/authorization";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; docId: string }> };

function workspaceRequiredResponse(): NextResponse {
  return NextResponse.json(
    { error: "Sign-in required." },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

function notFoundResponse(): NextResponse {
  return NextResponse.json({ error: "Document not found" }, { status: 404 });
}

/** A document reachable through the wrong project's URL is treated as absent. */
async function findScoped(workspaceId: string, projectId: string, docId: string) {
  const document = await knowledgeDocumentRepository.findById(workspaceId, docId);
  return document && document.projectId === projectId ? document : null;
}

export async function GET(request: NextRequest, { params }: Context) {
  ensureDatabaseReady();
  const workspaceId = await resolveWorkspaceIdForRequest(request);
  if (!workspaceId) return workspaceRequiredResponse();

  const { id, docId } = await params;
  const document = await findScoped(workspaceId, id, docId);
  if (!document) return notFoundResponse();
  return NextResponse.json({ document });
}

export async function PATCH(request: NextRequest, { params }: Context) {
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

  const { id, docId } = await params;
  const existing = await findScoped(workspaceId, id, docId);
  if (!existing) return notFoundResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = knowledgeDocumentUpdateSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid update", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const document = await knowledgeDocumentRepository.update(workspaceId, docId, parsed.data);
  if (!document) return notFoundResponse();
  return NextResponse.json({ document });
}

export async function DELETE(request: NextRequest, { params }: Context) {
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

  const { id, docId } = await params;
  const existing = await findScoped(workspaceId, id, docId);
  if (!existing) return notFoundResponse();

  const deleted = await knowledgeDocumentRepository.delete(workspaceId, docId);
  if (!deleted) return notFoundResponse();
  return NextResponse.json({ ok: true });
}

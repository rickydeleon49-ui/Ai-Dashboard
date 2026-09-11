import { NextResponse, type NextRequest } from "next/server";
import { projectRepository } from "@/db/repositories";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { projectUpdateSchema } from "@/core/projects/schema";
import { storage } from "@/core/storage";
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

export async function GET(request: NextRequest, { params }: Context) {
  ensureDatabaseReady();
  const workspaceId = await resolveWorkspaceIdForRequest(request);
  if (!workspaceId) return workspaceRequiredResponse();

  const { id } = await params;
  const project = await projectRepository.findById(workspaceId, id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return NextResponse.json({ project });
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

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = projectUpdateSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid update", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const project = await projectRepository.update(workspaceId, id, parsed.data);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return NextResponse.json({ project });
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

  const { id } = await params;
  const deleted = await projectRepository.delete(workspaceId, id);
  if (!deleted) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // The database cascade removes the file rows; the bytes are ours to clean up.
  // A failure here leaves unreferenced files, which is untidy but harmless, so
  // it must not turn a successful delete into an error.
  await storage.deleteProject(id).catch(() => undefined);

  return NextResponse.json({ ok: true });
}

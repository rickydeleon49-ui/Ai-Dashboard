import { NextResponse, type NextRequest } from "next/server";
import { activityRepository, projectRepository } from "@/db/repositories";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { resolveWorkspaceAndUserForRequest } from "@/core/workspaces/current-workspace";
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
  return NextResponse.json(
    { error: "Project not found" },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

/** GET /api/projects/:id/activity — returns recent activity events across all tasks in a project. */
export async function GET(request: NextRequest, { params }: Context) {
  ensureDatabaseReady();
  const resolved = await resolveWorkspaceAndUserForRequest(request);
  if (!resolved) return workspaceRequiredResponse();
  const { workspaceId, userId } = resolved;

  if (userId) {
    try {
      await requireRole(workspaceId, userId, "viewer");
    } catch (error) {
      if (error instanceof AuthorizationError) return authorizationErrorResponse(error);
      throw error;
    }
  }

  const { id } = await params;
  const project = await projectRepository.findById(workspaceId, id);
  if (!project) return projectNotFoundResponse();

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 200) : 50;

  const events = await activityRepository.listByProject(workspaceId, id, limit);
  return NextResponse.json({ events }, { headers: { "Cache-Control": "no-store" } });
}

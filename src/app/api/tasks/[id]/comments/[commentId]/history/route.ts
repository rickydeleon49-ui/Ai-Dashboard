import { NextResponse, type NextRequest } from "next/server";
import { commentRepository, taskRepository } from "@/db/repositories";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { resolveWorkspaceAndUserForRequest } from "@/core/workspaces/current-workspace";
import { AuthorizationError, authorizationErrorResponse, requireRole } from "@/core/workspaces/authorization";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; commentId: string }> };

function workspaceRequiredResponse(): NextResponse {
  return NextResponse.json(
    { error: "Sign-in required." },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

function notFoundResponse(message = "Comment not found"): NextResponse {
  return NextResponse.json(
    { error: message },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * GET /api/tasks/:id/comments/:commentId/history
 * Privileged audit endpoint returning full versioned edit history snapshots.
 * Restricted strictly to workspace admins/owners in accounts mode.
 * Cross-workspace requests return 404 indistinguishable from missing resources.
 */
export async function GET(request: NextRequest, { params }: Context) {
  ensureDatabaseReady();
  const resolved = await resolveWorkspaceAndUserForRequest(request);
  if (!resolved) return workspaceRequiredResponse();
  const { workspaceId, userId } = resolved;

  if (userId) {
    try {
      await requireRole(workspaceId, userId, "admin");
    } catch (error) {
      if (error instanceof AuthorizationError) return authorizationErrorResponse(error);
      throw error;
    }
  }

  const { id, commentId } = await params;
  const task = await taskRepository.findById(workspaceId, id);
  if (!task) return notFoundResponse("Task not found");

  const comment = await commentRepository.findById(workspaceId, id, commentId);
  if (!comment) return notFoundResponse("Comment not found");

  const history = await commentRepository.getEditHistory(workspaceId, id, commentId);
  return NextResponse.json({ history }, { headers: { "Cache-Control": "no-store" } });
}

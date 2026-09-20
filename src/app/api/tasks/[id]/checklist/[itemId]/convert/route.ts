import { NextResponse, type NextRequest } from "next/server";
import { checklistRepository, taskRepository } from "@/db/repositories";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { serializeTaskResponse } from "@/core/tasks/serialize";
import { ChecklistItemNotFoundError } from "@/core/tasks/errors";
import { resolveWorkspaceAndUserForRequest } from "@/core/workspaces/current-workspace";
import { AuthorizationError, authorizationErrorResponse, requireRole } from "@/core/workspaces/authorization";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; itemId: string }> };

function workspaceRequiredResponse(): NextResponse {
  return NextResponse.json(
    { error: "Sign-in required." },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

function notFoundResponse(message = "Not found"): NextResponse {
  return NextResponse.json(
    { error: message },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

/** POST /api/tasks/:id/checklist/:itemId/convert — converts checklist item to full task. */
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

  const { id, itemId } = await params;
  const task = await taskRepository.findById(workspaceId, id);
  if (!task) return notFoundResponse("Task not found");

  try {
    const createdTask = await checklistRepository.convertToTask(workspaceId, id, itemId, {
      actorUserId: userId ?? undefined,
    });

    return NextResponse.json(
      { task: serializeTaskResponse(createdTask) },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ChecklistItemNotFoundError) {
      return notFoundResponse(error.message);
    }
    throw error;
  }
}

import { NextResponse, type NextRequest } from "next/server";
import { checklistRepository, taskRepository } from "@/db/repositories";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { checklistItemUpdateSchema } from "@/core/tasks/schema";
import {
  ChecklistItemNotFoundError,
  InvalidChecklistItemError,
} from "@/core/tasks/errors";
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

function notFoundResponse(): NextResponse {
  return NextResponse.json(
    { error: "Checklist item not found" },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

/** PATCH /api/tasks/:id/checklist/:itemId — updates text and/or done status. */
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

  const { id, itemId } = await params;
  const task = await taskRepository.findById(workspaceId, id);
  if (!task) return notFoundResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Body must be JSON" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const parsed = checklistItemUpdateSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid update payload", issues: parsed.error.issues },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    let item = await checklistRepository.findById(workspaceId, id, itemId);
    if (!item) return notFoundResponse();

    if (parsed.data.done === true) {
      item = await checklistRepository.complete(workspaceId, id, itemId, {
        actorUserId: userId ?? undefined,
      });
    } else if (parsed.data.done === false) {
      item = await checklistRepository.reopen(workspaceId, id, itemId, {
        actorUserId: userId ?? undefined,
      });
    }

    if (parsed.data.text !== undefined) {
      item = await checklistRepository.update(workspaceId, id, itemId, {
        text: parsed.data.text,
      });
    }

    if (!item) return notFoundResponse();
    return NextResponse.json({ item }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof InvalidChecklistItemError) {
      return NextResponse.json(
        { error: error.message },
        { status: 422, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (error instanceof ChecklistItemNotFoundError) {
      return notFoundResponse();
    }
    throw error;
  }
}

/** DELETE /api/tasks/:id/checklist/:itemId — deletes a checklist item. */
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

  const { id, itemId } = await params;
  const task = await taskRepository.findById(workspaceId, id);
  if (!task) return notFoundResponse();

  const deleted = await checklistRepository.delete(workspaceId, id, itemId, {
    actorUserId: userId ?? undefined,
  });
  if (!deleted) return notFoundResponse();

  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

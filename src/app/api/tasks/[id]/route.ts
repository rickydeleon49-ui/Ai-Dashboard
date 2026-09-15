import { NextResponse, type NextRequest } from "next/server";
import { milestoneRepository, taskRepository } from "@/db/repositories";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { taskUpdateSchema } from "@/core/tasks/schema";
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

function notFoundResponse(): NextResponse {
  return NextResponse.json({ error: "Task not found" }, { status: 404 });
}

/**
 * Addressed globally (`/api/tasks/:id`, not nested under a project) since
 * My Work and a dependency's blockers/dependents span every project in the
 * workspace — `resolveWorkspaceIdForRequest`/`requireRole` already scope
 * every call to the caller's own workspace, which is all the isolation a
 * global id needs.
 */
export async function GET(request: NextRequest, { params }: Context) {
  ensureDatabaseReady();
  const workspaceId = await resolveWorkspaceIdForRequest(request);
  if (!workspaceId) return workspaceRequiredResponse();

  const { id } = await params;
  const task = await taskRepository.findById(workspaceId, id);
  if (!task) return notFoundResponse();
  return NextResponse.json({ task });
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
  const existing = await taskRepository.findById(workspaceId, id);
  if (!existing) return notFoundResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = taskUpdateSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid update", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  // `projectId` is immutable (see TaskUpdateInput), so any milestone/parent
  // reference this update sets must belong to the task's own project —
  // neither repository's `update()` checks that on its own.
  if (parsed.data.milestoneId) {
    const milestone = await milestoneRepository.findById(workspaceId, parsed.data.milestoneId);
    if (!milestone || milestone.projectId !== existing.projectId) {
      return NextResponse.json({ error: "Milestone not found in this project" }, { status: 422 });
    }
  }

  if (parsed.data.parentTaskId) {
    if (parsed.data.parentTaskId === id) {
      return NextResponse.json({ error: "A task cannot be its own parent" }, { status: 422 });
    }
    const parent = await taskRepository.findById(workspaceId, parsed.data.parentTaskId);
    if (!parent || parent.projectId !== existing.projectId) {
      return NextResponse.json({ error: "Parent task not found in this project" }, { status: 422 });
    }
  }

  const task = await taskRepository.update(workspaceId, id, parsed.data);
  if (!task) return notFoundResponse();
  return NextResponse.json({ task });
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
  const deleted = await taskRepository.delete(workspaceId, id);
  if (!deleted) return notFoundResponse();
  return NextResponse.json({ ok: true });
}

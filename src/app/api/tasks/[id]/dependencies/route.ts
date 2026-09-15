import { NextResponse, type NextRequest } from "next/server";
import { taskRepository } from "@/db/repositories";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { taskDependencyCreateSchema } from "@/core/tasks/schema";
import { DependencyCycleError } from "@/core/tasks/errors";
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

function taskNotFoundResponse(): NextResponse {
  return NextResponse.json({ error: "Task not found" }, { status: 404 });
}

/** GET /api/tasks/:id/dependencies — both directions: what blocks it, and what it blocks. */
export async function GET(request: NextRequest, { params }: Context) {
  ensureDatabaseReady();
  const workspaceId = await resolveWorkspaceIdForRequest(request);
  if (!workspaceId) return workspaceRequiredResponse();

  const { id } = await params;
  const task = await taskRepository.findById(workspaceId, id);
  if (!task) return taskNotFoundResponse();

  const [blockers, dependents] = await Promise.all([
    taskRepository.listBlockers(workspaceId, id),
    taskRepository.listDependents(workspaceId, id),
  ]);
  return NextResponse.json({ blockers, dependents });
}

/**
 * POST /api/tasks/:id/dependencies — records that :id cannot be done until
 * `dependsOnTaskId` is. Both tasks must already resolve within the caller's
 * own workspace (checked here, not just inside `addDependency`, so a
 * missing task and a would-be cross-workspace reference both read as a
 * plain 404 rather than the repository's defense-in-depth internal error).
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
  const task = await taskRepository.findById(workspaceId, id);
  if (!task) return taskNotFoundResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = taskDependencyCreateSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid dependency", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const dependsOn = await taskRepository.findById(workspaceId, parsed.data.dependsOnTaskId);
  if (!dependsOn) {
    return NextResponse.json({ error: "dependsOnTaskId not found" }, { status: 404 });
  }

  try {
    await taskRepository.addDependency(workspaceId, id, parsed.data.dependsOnTaskId);
  } catch (error) {
    if (error instanceof DependencyCycleError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}

/** DELETE /api/tasks/:id/dependencies?dependsOnTaskId=... — idempotent. */
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
  const task = await taskRepository.findById(workspaceId, id);
  if (!task) return taskNotFoundResponse();

  const dependsOnTaskId = new URL(request.url).searchParams.get("dependsOnTaskId");
  if (!dependsOnTaskId) {
    return NextResponse.json({ error: "dependsOnTaskId query parameter is required" }, { status: 400 });
  }

  await taskRepository.removeDependency(workspaceId, id, dependsOnTaskId);
  return NextResponse.json({ ok: true });
}

import { NextResponse, type NextRequest } from "next/server";
import { milestoneRepository, projectRepository, taskRepository } from "@/db/repositories";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { taskCreateSchema, taskQuerySchema } from "@/core/tasks/schema";
import type { TaskQuery } from "@/core/tasks/types";
import {
  resolveWorkspaceAndUserForRequest,
  resolveWorkspaceIdForRequest,
} from "@/core/workspaces/current-workspace";
import { AuthorizationError, authorizationErrorResponse, requireRole } from "@/core/workspaces/authorization";
import {
  InvalidAssigneeError,
  InvalidParentTaskError,
  TaskLockTimeoutError,
} from "@/core/tasks/errors";

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

/** `parentTaskId=none` is the query-string spelling of "top-level tasks only" (see core/tasks/schema.ts). */
function toTaskQuery(parsed: {
  status?: TaskQuery["status"];
  priority?: TaskQuery["priority"];
  milestoneId?: string;
  assigneeId?: string;
  parentTaskId?: string;
  sort?: TaskQuery["sort"];
  limit?: number;
}): TaskQuery {
  return {
    ...parsed,
    parentTaskId:
      parsed.parentTaskId === undefined ? undefined : parsed.parentTaskId === "none" ? null : parsed.parentTaskId,
  };
}

/** GET /api/projects/:id/tasks */
export async function GET(request: NextRequest, { params }: Context) {
  ensureDatabaseReady();
  const workspaceId = await resolveWorkspaceIdForRequest(request);
  if (!workspaceId) return workspaceRequiredResponse();

  const { id } = await params;
  const project = await projectRepository.findById(workspaceId, id);
  if (!project) return projectNotFoundResponse();

  const url = new URL(request.url);
  const parsed = taskQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const tasks = await taskRepository.list(workspaceId, id, toTaskQuery(parsed.data));
  return NextResponse.json({ tasks });
}

/**
 * POST /api/projects/:id/tasks — a write, so membership alone is not
 * enough; see the sibling Projects route for the same reasoning. A
 * `milestoneId`/`parentTaskId` that resolves outside this project is
 * rejected rather than silently linking across projects — neither
 * repository's `create()` checks that on its own (see their own comments),
 * so it's this route's job.
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

  const parsed = taskCreateSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid task", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  if (parsed.data.milestoneId) {
    const milestone = await milestoneRepository.findById(workspaceId, parsed.data.milestoneId);
    if (!milestone || milestone.projectId !== id) {
      return NextResponse.json({ error: "Milestone not found in this project" }, { status: 422 });
    }
  }

  if (parsed.data.parentTaskId) {
    const parent = await taskRepository.findById(workspaceId, parsed.data.parentTaskId);
    if (!parent || parent.projectId !== id) {
      return NextResponse.json({ error: "Parent task not found in this project" }, { status: 422 });
    }
    if (parent.parentTaskId !== null) {
      return NextResponse.json(
        { error: "A parent task must be a top-level task; subtasks cannot be nested" },
        { status: 422 },
      );
    }
  }

  try {
    const task = await taskRepository.create(workspaceId, { ...parsed.data, projectId: id });
    return NextResponse.json({ task }, { status: 201 });
  } catch (error) {
    if (error instanceof TaskLockTimeoutError) {
      return NextResponse.json(
        { error: error.message, retryable: true },
        { status: 503, headers: { "Retry-After": "1" } },
      );
    }
    if (error instanceof InvalidParentTaskError || error instanceof InvalidAssigneeError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }
}

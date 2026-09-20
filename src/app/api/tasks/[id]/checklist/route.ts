import { NextResponse, type NextRequest } from "next/server";
import { checklistRepository, taskRepository } from "@/db/repositories";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { checklistItemCreateSchema, checklistReorderSchema } from "@/core/tasks/schema";
import {
  ChecklistItemNotFoundError,
  ChecklistLimitExceededError,
  InvalidChecklistItemError,
} from "@/core/tasks/errors";
import {
  resolveWorkspaceAndUserForRequest,
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
  return NextResponse.json(
    { error: "Task not found" },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

/** GET /api/tasks/:id/checklist — returns ordered checklist items. */
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
  const task = await taskRepository.findById(workspaceId, id);
  if (!task) return taskNotFoundResponse();

  const items = await checklistRepository.list(workspaceId, id);
  return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
}

/** POST /api/tasks/:id/checklist — creates a new checklist item. */
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
    return NextResponse.json(
      { error: "Body must be JSON" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const parsed = checklistItemCreateSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid checklist item", issues: parsed.error.issues },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const item = await checklistRepository.create(workspaceId, id, parsed.data, {
      actorUserId: userId ?? undefined,
    });
    return NextResponse.json({ item }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ChecklistLimitExceededError || error instanceof InvalidChecklistItemError) {
      return NextResponse.json(
        { error: error.message },
        { status: 422, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (error instanceof ChecklistItemNotFoundError) {
      return taskNotFoundResponse();
    }
    throw error;
  }
}

/** PUT /api/tasks/:id/checklist — reorders checklist items. */
export async function PUT(request: NextRequest, { params }: Context) {
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
    return NextResponse.json(
      { error: "Body must be JSON" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const parsed = checklistReorderSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid reorder payload", issues: parsed.error.issues },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const items = await checklistRepository.reorder(workspaceId, id, parsed.data.itemIds);
    return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof InvalidChecklistItemError) {
      return NextResponse.json(
        { error: error.message },
        { status: 422, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (error instanceof ChecklistItemNotFoundError) {
      return taskNotFoundResponse();
    }
    throw error;
  }
}

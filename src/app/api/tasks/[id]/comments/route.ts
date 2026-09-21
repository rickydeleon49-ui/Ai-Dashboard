import { NextResponse, type NextRequest } from "next/server";
import { commentRepository, taskRepository } from "@/db/repositories";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { commentCreateSchema, commentPaginationQuerySchema } from "@/core/tasks/schema";
import {
  CommentNotFoundError,
  InvalidCommentError,
  InvalidMentionError,
  InvalidPaginationError,
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

/** GET /api/tasks/:id/comments — lists all comments for a task. */
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

  const { searchParams } = new URL(request.url);
  const rawQuery: Record<string, unknown> = {};
  if (searchParams.has("limit")) {
    rawQuery.limit = searchParams.get("limit");
  }
  if (searchParams.has("cursor")) {
    rawQuery.cursor = searchParams.get("cursor");
  }

  const parsed = commentPaginationQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid pagination query", issues: parsed.error.issues },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const result = await commentRepository.list(workspaceId, id, parsed.data);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof InvalidPaginationError) {
      return NextResponse.json(
        { error: error.message },
        { status: 422, headers: { "Cache-Control": "no-store" } },
      );
    }
    throw error;
  }
}

/** POST /api/tasks/:id/comments — creates a new comment on a task. */
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

  const parsed = commentCreateSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid comment", issues: parsed.error.issues },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const comment = await commentRepository.create(workspaceId, id, parsed.data, {
      actorUserId: userId ?? undefined,
    });
    return NextResponse.json({ comment }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof InvalidMentionError) {
      return NextResponse.json(
        { error: error.message, invalidUserId: error.invalidUserId },
        { status: 422, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (error instanceof InvalidCommentError) {
      return NextResponse.json(
        { error: error.message },
        { status: 422, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (error instanceof CommentNotFoundError) {
      return taskNotFoundResponse();
    }
    throw error;
  }
}

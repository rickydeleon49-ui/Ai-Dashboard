import { NextResponse, type NextRequest } from "next/server";
import { commentRepository, taskRepository } from "@/db/repositories";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { commentUpdateSchema } from "@/core/tasks/schema";
import {
  CommentNotFoundError,
  InvalidCommentError,
  InvalidMentionError,
} from "@/core/tasks/errors";
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

/** GET /api/tasks/:id/comments/:commentId — returns comment details without exposing edit history. */
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

  const { id, commentId } = await params;
  const task = await taskRepository.findById(workspaceId, id);
  if (!task) return notFoundResponse("Task not found");

  const comment = await commentRepository.findById(workspaceId, id, commentId);
  if (!comment) return notFoundResponse("Comment not found");

  return NextResponse.json({ comment }, { headers: { "Cache-Control": "no-store" } });
}

/** PATCH /api/tasks/:id/comments/:commentId — edits comment body (author only). */
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

  const { id, commentId } = await params;
  const task = await taskRepository.findById(workspaceId, id);
  if (!task) return notFoundResponse("Task not found");

  const comment = await commentRepository.findById(workspaceId, id, commentId);
  if (!comment) return notFoundResponse("Comment not found");

  if (comment.isDeleted) {
    return NextResponse.json(
      { error: "Cannot edit a deleted comment" },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }

  // In accounts mode, only the author can edit their own comment
  if (userId && comment.authorId !== userId) {
    return NextResponse.json(
      { error: "Only comment authors can edit their comments" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Body must be JSON" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const parsed = commentUpdateSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid update payload", issues: parsed.error.issues },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const updated = await commentRepository.update(
      workspaceId,
      id,
      commentId,
      parsed.data,
      { actorUserId: userId ?? undefined },
    );
    if (!updated) return notFoundResponse("Comment not found");
    return NextResponse.json({ comment: updated }, { headers: { "Cache-Control": "no-store" } });
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
      return notFoundResponse("Comment not found");
    }
    throw error;
  }
}

/** DELETE /api/tasks/:id/comments/:commentId — soft-deletes a comment (author OR admin/owner). */
export async function DELETE(request: NextRequest, { params }: Context) {
  ensureDatabaseReady();
  const resolved = await resolveWorkspaceAndUserForRequest(request);
  if (!resolved) return workspaceRequiredResponse();
  const { workspaceId, userId } = resolved;

  let membershipRole: string | undefined;
  if (userId) {
    try {
      const membership = await requireRole(workspaceId, userId, "member");
      membershipRole = membership.role;
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

  if (comment.isDeleted) {
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  }

  // In accounts mode: author OR admin/owner can delete
  if (userId) {
    const isAuthor = comment.authorId === userId;
    const isAdminOrOwner = membershipRole === "admin" || membershipRole === "owner";
    if (!isAuthor && !isAdminOrOwner) {
      return NextResponse.json(
        { error: "Only the author or a workspace admin/owner can delete this comment" },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  const deleted = await commentRepository.delete(workspaceId, id, commentId, {
    actorUserId: userId ?? undefined,
  });
  if (!deleted) return notFoundResponse("Comment not found");

  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

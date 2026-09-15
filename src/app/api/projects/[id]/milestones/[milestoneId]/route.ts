import { NextResponse, type NextRequest } from "next/server";
import { milestoneRepository } from "@/db/repositories";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { milestoneUpdateSchema } from "@/core/tasks/schema";
import {
  resolveWorkspaceAndUserForRequest,
  resolveWorkspaceIdForRequest,
} from "@/core/workspaces/current-workspace";
import { AuthorizationError, authorizationErrorResponse, requireRole } from "@/core/workspaces/authorization";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; milestoneId: string }> };

function workspaceRequiredResponse(): NextResponse {
  return NextResponse.json(
    { error: "Sign-in required." },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

function notFoundResponse(): NextResponse {
  return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
}

/** A milestone reachable through the wrong project's URL is treated as absent. */
async function findScoped(workspaceId: string, projectId: string, milestoneId: string) {
  const milestone = await milestoneRepository.findById(workspaceId, milestoneId);
  return milestone && milestone.projectId === projectId ? milestone : null;
}

export async function GET(request: NextRequest, { params }: Context) {
  ensureDatabaseReady();
  const workspaceId = await resolveWorkspaceIdForRequest(request);
  if (!workspaceId) return workspaceRequiredResponse();

  const { id, milestoneId } = await params;
  const milestone = await findScoped(workspaceId, id, milestoneId);
  if (!milestone) return notFoundResponse();
  return NextResponse.json({ milestone });
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

  const { id, milestoneId } = await params;
  const existing = await findScoped(workspaceId, id, milestoneId);
  if (!existing) return notFoundResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = milestoneUpdateSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid update", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const milestone = await milestoneRepository.update(workspaceId, milestoneId, parsed.data);
  if (!milestone) return notFoundResponse();
  return NextResponse.json({ milestone });
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

  const { id, milestoneId } = await params;
  const existing = await findScoped(workspaceId, id, milestoneId);
  if (!existing) return notFoundResponse();

  const deleted = await milestoneRepository.delete(workspaceId, milestoneId);
  if (!deleted) return notFoundResponse();
  return NextResponse.json({ ok: true });
}

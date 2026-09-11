import { NextResponse, type NextRequest } from "next/server";
import { projectRepository } from "@/db/repositories";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { projectCreateSchema, projectQuerySchema } from "@/core/projects/schema";
import {
  resolveWorkspaceAndUserForRequest,
  resolveWorkspaceIdForRequest,
} from "@/core/workspaces/current-workspace";
import { AuthorizationError, authorizationErrorResponse, requireRole } from "@/core/workspaces/authorization";

export const dynamic = "force-dynamic";

function workspaceRequiredResponse(): NextResponse {
  return NextResponse.json(
    { error: "Sign-in required." },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

/** GET /api/projects — the same query surface the library UI uses. */
export async function GET(request: NextRequest) {
  ensureDatabaseReady();
  const workspaceId = await resolveWorkspaceIdForRequest(request);
  if (!workspaceId) return workspaceRequiredResponse();

  const url = new URL(request.url);
  const parsed = projectQuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const projects = await projectRepository.list(workspaceId, parsed.data);
  return NextResponse.json({ projects });
}

/**
 * POST /api/projects — create a manual project. Membership alone (what
 * `resolveWorkspaceIdForRequest` above already checks) only proves "may
 * read" — this is a write, so a viewer must be turned away even though
 * they do belong to the workspace.
 */
export async function POST(request: NextRequest) {
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = projectCreateSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid project", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const project = await projectRepository.create(workspaceId, parsed.data);
  return NextResponse.json({ project }, { status: 201 });
}

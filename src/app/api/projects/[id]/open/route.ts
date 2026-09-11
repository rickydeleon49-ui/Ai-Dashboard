import { NextResponse, type NextRequest } from "next/server";
import { projectRepository } from "@/db/repositories";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { resolveWorkspaceIdForRequest } from "@/core/workspaces/current-workspace";

export const dynamic = "force-dynamic";

/**
 * POST /api/projects/:id/open
 * Stamps `lastOpenedAt` so the dashboard can show "recently opened".
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabaseReady();
  const workspaceId = await resolveWorkspaceIdForRequest(request);
  if (!workspaceId) {
    return NextResponse.json(
      { error: "Sign-in required." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { id } = await params;
  const project = await projectRepository.markOpened(workspaceId, id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return NextResponse.json({ project });
}

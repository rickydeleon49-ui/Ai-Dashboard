import { NextResponse } from "next/server";
import { projectRepository } from "@/db/repositories";
import { ensureDatabaseReady } from "@/db/bootstrap";

export const dynamic = "force-dynamic";

/**
 * POST /api/projects/:id/open
 * Stamps `lastOpenedAt` so the dashboard can show "recently opened".
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabaseReady();
  const { id } = await params;
  const project = await projectRepository.markOpened(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return NextResponse.json({ project });
}

import { NextResponse } from "next/server";
import { LOCAL_WORKSPACE_ID, projectRepository } from "@/db/repositories";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { projectUpdateSchema } from "@/core/projects/schema";
import { storage } from "@/core/storage";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  ensureDatabaseReady();
  const { id } = await params;
  const project = await projectRepository.findById(LOCAL_WORKSPACE_ID, id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return NextResponse.json({ project });
}

export async function PATCH(request: Request, { params }: Context) {
  ensureDatabaseReady();
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = projectUpdateSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid update", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const project = await projectRepository.update(LOCAL_WORKSPACE_ID, id, parsed.data);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return NextResponse.json({ project });
}

export async function DELETE(_request: Request, { params }: Context) {
  ensureDatabaseReady();
  const { id } = await params;
  const deleted = await projectRepository.delete(LOCAL_WORKSPACE_ID, id);
  if (!deleted) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // The database cascade removes the file rows; the bytes are ours to clean up.
  // A failure here leaves unreferenced files, which is untidy but harmless, so
  // it must not turn a successful delete into an error.
  await storage.deleteProject(id).catch(() => undefined);

  return NextResponse.json({ ok: true });
}

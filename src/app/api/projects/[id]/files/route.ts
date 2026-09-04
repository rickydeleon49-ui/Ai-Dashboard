import { NextResponse } from "next/server";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { projectRepository } from "@/db/repositories";
import { addProjectFile, listProjectFiles } from "@/core/files/service";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  ensureDatabaseReady();
  const { id } = await params;
  return NextResponse.json({ files: await listProjectFiles(id) });
}

/** POST — multipart upload of one or more files onto a project. */
export async function POST(request: Request, { params }: Context) {
  ensureDatabaseReady();
  const { id } = await params;

  const project = await projectRepository.findById(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected a multipart upload" },
      { status: 400 },
    );
  }

  const uploads = form.getAll("files").filter((v): v is File => v instanceof File);
  if (uploads.length === 0) {
    return NextResponse.json({ error: "No files were included" }, { status: 422 });
  }

  const saved = [];
  for (const upload of uploads) {
    try {
      saved.push(await addProjectFile(id, upload));
    } catch (error) {
      // Report the first rejection rather than silently storing a partial set.
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Upload failed" },
        { status: 422 },
      );
    }
  }

  // Attaching files is a change to the project, so its timestamp should move.
  await projectRepository.update(id, {});

  return NextResponse.json({ files: saved }, { status: 201 });
}

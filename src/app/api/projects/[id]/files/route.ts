import { NextResponse } from "next/server";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { projectRepository } from "@/db/repositories";
import { addProjectFiles, listProjectFiles } from "@/core/files/service";

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

  const outcomes = await addProjectFiles(id, uploads);
  const saved = outcomes.filter((o) => o.ok).map((o) => o.file);
  const failed = outcomes
    .filter((o) => !o.ok)
    .map(({ filename, error }) => ({ filename, error }));

  // Only touch the project's timestamp if something was actually attached.
  if (saved.length > 0) await projectRepository.update(id, {});

  /*
   * A partly-successful batch is reported as success with the failures listed,
   * not as an error. The stored files are real and are already visible on the
   * page — returning a bare 4xx would tell the user nothing happened while the
   * list in front of them says otherwise.
   *
   * Nothing stored at all is a genuine failure, so that keeps the 422.
   */
  if (saved.length === 0) {
    return NextResponse.json(
      { error: failed[0]?.error ?? "Upload failed", files: [], failed },
      { status: 422 },
    );
  }

  return NextResponse.json({ files: saved, failed }, { status: 201 });
}

import { NextResponse } from "next/server";
import { isAccountsMode } from "@/lib/auth-mode";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** GET — download a stored file. */
export async function GET(_request: Request, { params }: Context) {
  if (isAccountsMode()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const { ensureDatabaseReady } = await import("@/db/bootstrap");
  const { findFile, readFileContents } = await import("@/core/files/service");

  ensureDatabaseReady();
  const { id } = await params;

  const file = await findFile(id);
  if (!file) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  let contents: Buffer;
  try {
    contents = await readFileContents(file);
  } catch {
    return NextResponse.json(
      { error: "The stored file is missing from disk" },
      { status: 410 },
    );
  }

  return new NextResponse(new Uint8Array(contents), {
    headers: {
      // Always an attachment: serving user-supplied bytes inline would let an
      // uploaded HTML or SVG file execute scripts on this origin.
      "Content-Type": file.mimeType ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "Content-Length": String(contents.byteLength),
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function DELETE(_request: Request, { params }: Context) {
  if (isAccountsMode()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const { ensureDatabaseReady } = await import("@/db/bootstrap");
  const { deleteProjectFile } = await import("@/core/files/service");

  ensureDatabaseReady();
  const { id } = await params;
  const deleted = await deleteProjectFile(id);
  if (!deleted) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

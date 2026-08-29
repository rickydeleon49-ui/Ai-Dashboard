import { NextResponse } from "next/server";
import { projectRepository } from "@/db/repositories";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { projectCreateSchema, projectQuerySchema } from "@/core/projects/schema";

export const dynamic = "force-dynamic";

/** GET /api/projects — the same query surface the library UI uses. */
export async function GET(request: Request) {
  ensureDatabaseReady();
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

  const projects = await projectRepository.list(parsed.data);
  return NextResponse.json({ projects });
}

/** POST /api/projects — create a manual project. */
export async function POST(request: Request) {
  ensureDatabaseReady();
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

  const project = await projectRepository.create(parsed.data);
  return NextResponse.json({ project }, { status: 201 });
}

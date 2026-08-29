import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { linkRepositoryToProject, unlinkRepository } from "@/core/github/service";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ externalId: z.string().min(1) });

/** POST /api/github/link — add a synced repository to the dashboard. */
export async function POST(request: Request) {
  ensureDatabaseReady();
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "externalId is required" }, { status: 422 });
  }

  try {
    const project = await linkRepositoryToProject(parsed.data.externalId);
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not link repository" },
      { status: 400 },
    );
  }
}

/** DELETE /api/github/link — remove the dashboard project, keep the repo cached. */
export async function DELETE(request: Request) {
  ensureDatabaseReady();
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "externalId is required" }, { status: 422 });
  }
  await unlinkRepository(parsed.data.externalId);
  return NextResponse.json({ ok: true });
}

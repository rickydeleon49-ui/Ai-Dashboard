import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { projects } from "@/db/schema";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import { nextTaskForProject } from "@/core/agents/task-link";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** The project's next eligible task for an agent run: { task: {id,title} | null, reason }. */
export async function GET(_request: NextRequest, context: RouteContext) {
  if (!isAgentRunsEnabled()) {
    return new NextResponse(null, { status: 404 });
  }
  ensureDatabaseReady();

  const { id } = await context.params;
  const project = db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).get();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return NextResponse.json(nextTaskForProject(db, id));
}

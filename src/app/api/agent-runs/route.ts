import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { projects } from "@/db/schema";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import { runRequestSchema } from "@/core/agents/schema";
import { createRun, listRuns } from "@/core/agents/runs";
import { readAntigravityInventory } from "@/core/agents/adapters/antigravity-inventory";
import { checkAntigravityAcknowledgement } from "@/core/agents/antigravity-ack";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isAgentRunsEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  ensureDatabaseReady();

  const url = new URL(request.url);
  const projectIdParam = url.searchParams.get("projectId");
  const limitParam = url.searchParams.get("limit");

  const projectId = projectIdParam ? projectIdParam.trim() : undefined;
  const limit = limitParam !== null ? Number.parseInt(limitParam, 10) : undefined;

  const runs = await listRuns(db, {
    projectId: projectId || undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  });

  return NextResponse.json({ runs });
}

export async function POST(request: NextRequest) {
  if (!isAgentRunsEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  ensureDatabaseReady();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = runRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const project = db
    .select({
      id: projects.id,
      localPath: projects.localPath,
    })
    .from(projects)
    .where(eq(projects.id, parsed.data.projectId))
    .get();

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (!project.localPath || project.localPath.trim().length === 0) {
    return NextResponse.json(
      { error: "Project has no local folder" },
      { status: 409 },
    );
  }

  if (parsed.data.roles.implementer.provider === "antigravity") {
    const inventory = await readAntigravityInventory();
    const ackCheck = checkAntigravityAcknowledgement(parsed.data, inventory);
    if (!ackCheck.ok) {
      return NextResponse.json(
        {
          error: ackCheck.error,
          inventory: {
            plugins: inventory.plugins,
            mcpServers: inventory.mcpServers,
          },
        },
        { status: 409 },
      );
    }
  }

  const run = await createRun(db, parsed.data, {
    projectLocalPath: project.localPath.trim(),
  });

  return NextResponse.json({ run }, { status: 201 });
}

import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { projects } from "@/db/schema";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import { requireRecentSignIn } from "@/core/auth/operator-routes";
import { isSelfHostedMode } from "@/lib/auth-mode";
import { getPolicy, PolicyError, savePolicy } from "@/core/agents/policy";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;

type RouteContext = { params: Promise<{ id: string }> };

function projectExists(id: string): boolean {
  return Boolean(db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).get());
}

export async function GET(_request: NextRequest, context: RouteContext) {
  if (!isAgentRunsEnabled()) {
    return new NextResponse(null, { status: 404 });
  }
  ensureDatabaseReady();

  const { id } = await context.params;
  if (!projectExists(id)) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  try {
    return NextResponse.json({ policy: getPolicy(db, id) });
  } catch (error) {
    return NextResponse.json(
      { error: `Stored policy is invalid: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest, context: RouteContext) {
  if (!isAgentRunsEnabled()) {
    return new NextResponse(null, { status: 404 });
  }
  // Self-hosted: policy changes need a sign-in within the last 5 minutes.
  if (isSelfHostedMode()) {
    const denied = await requireRecentSignIn(request);
    if (denied) return denied;
  }
  ensureDatabaseReady();

  const { id } = await context.params;
  if (!projectExists(id)) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    return NextResponse.json({ policy: savePolicy(db, id, body) });
  } catch (error) {
    if (error instanceof PolicyError) {
      return NextResponse.json({ error: error.message, issues: error.issues }, { status: 400 });
    }
    throw error;
  }
}

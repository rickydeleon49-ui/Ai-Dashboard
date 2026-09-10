import { NextResponse, type NextRequest } from "next/server";
import {
  accountsModeDisabledResponse,
  accountsModeEnabled,
  sessionFromRequest,
} from "@/core/auth/session";
import { createWorkspaceSchema } from "@/core/workspaces/schema";
import { createTeamWorkspace, listWorkspacesForUser } from "@/core/workspaces/service";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** GET — every workspace the signed-in user belongs to, with their role in each. */
export async function GET(request: NextRequest) {
  if (!accountsModeEnabled()) return accountsModeDisabledResponse();

  const session = await sessionFromRequest(request);
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json(
      { error: "Sign-in required." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const requested = Number(request.nextUrl.searchParams.get("limit"));
  const limit =
    Number.isFinite(requested) && requested > 0
      ? Math.min(requested, MAX_LIMIT)
      : DEFAULT_LIMIT;

  const workspaces = await listWorkspacesForUser(userId, limit);
  return NextResponse.json({ workspaces });
}

/** POST — create a team workspace, with the caller as its sole owner. */
export async function POST(request: NextRequest) {
  if (!accountsModeEnabled()) return accountsModeDisabledResponse();

  const session = await sessionFromRequest(request);
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json(
      { error: "Sign-in required." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = createWorkspaceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid workspace" },
      { status: 422 },
    );
  }

  const workspace = await createTeamWorkspace(userId, parsed.data.name);
  return NextResponse.json({ workspace }, { status: 201 });
}

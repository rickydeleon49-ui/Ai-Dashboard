import { NextResponse, type NextRequest } from "next/server";
import {
  accountsModeDisabledResponse,
  accountsModeEnabled,
  sessionFromRequest,
} from "@/core/auth/session";
import { AuthorizationError, authorizationErrorResponse, requireRole } from "@/core/workspaces/authorization";
import { switchWorkspaceSchema } from "@/core/workspaces/schema";
import { getWorkspace } from "@/core/workspaces/service";
import { CURRENT_WORKSPACE_COOKIE } from "@/core/workspaces/current-workspace";

export const dynamic = "force-dynamic";

/**
 * PUT — switch the signed-in user's "current" workspace: the one their
 * Settings page (and, once later steps add workspace-scoped pages, those
 * too) treats as selected. Membership is re-checked here rather than
 * trusted from whatever the client claims — a workspace id alone proves
 * nothing about whether the caller belongs to it.
 */
export async function PUT(request: NextRequest) {
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

  const parsed = switchWorkspaceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 422 },
    );
  }

  try {
    await requireRole(parsed.data.workspaceId, userId, "viewer");
  } catch (error) {
    if (error instanceof AuthorizationError) return authorizationErrorResponse(error);
    throw error;
  }

  const workspace = await getWorkspace(parsed.data.workspaceId);
  if (!workspace) {
    // Passed the membership check yet the workspace itself is gone: a
    // concurrent deletion between those two reads, not a client error.
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  const response = NextResponse.json({ workspace });
  response.cookies.set(CURRENT_WORKSPACE_COOKIE, workspace.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}

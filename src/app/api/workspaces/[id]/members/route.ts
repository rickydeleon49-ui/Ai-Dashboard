import { NextResponse, type NextRequest } from "next/server";
import {
  accountsModeDisabledResponse,
  accountsModeEnabled,
  sessionFromRequest,
} from "@/core/auth/session";
import {
  AuthorizationError,
  authorizationErrorResponse,
  requireRole,
} from "@/core/workspaces/authorization";
import { listMembersQuerySchema } from "@/core/workspaces/schema";
import { listMembersPaginated } from "@/core/workspaces/service";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function requireSession(request: NextRequest): Promise<string | NextResponse> {
  const session = await sessionFromRequest(request);
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json(
      { error: "Sign-in required." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  return userId;
}

/**
 * GET /api/workspaces/[id]/members
 * Viewer level and up.
 * Query params: limit / offset / search / status (validated; 422 on invalid).
 * Non-admins requesting non-active status receive HTTP 403.
 * Returns { members, total, limit, offset } made of safe user summaries only.
 */
export async function GET(request: NextRequest, { params }: Context) {
  if (!accountsModeEnabled()) return accountsModeDisabledResponse();
  const userId = await requireSession(request);
  if (userId instanceof NextResponse) return userId;

  const { id: workspaceId } = await params;
  let callerMembership;
  try {
    callerMembership = await requireRole(workspaceId, userId, "viewer");
  } catch (error) {
    if (error instanceof AuthorizationError) return authorizationErrorResponse(error);
    throw error;
  }

  const url = new URL(request.url);
  const queryParams: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    queryParams[key] = value;
  }

  const parsed = listMembersQuerySchema.safeParse(queryParams);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid query parameters." },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }

  const isElevated = callerMembership.role === "owner" || callerMembership.role === "admin";
  if (!isElevated && parsed.data.status && parsed.data.status !== "active") {
    return NextResponse.json(
      { error: "Only admins and owners can filter by non-active statuses." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await listMembersPaginated(workspaceId, {
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    search: parsed.data.search,
    status: isElevated ? parsed.data.status ?? "active" : "active",
    callerRole: callerMembership.role,
  });

  return NextResponse.json(
    {
      members: result.members,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

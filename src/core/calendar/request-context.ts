import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { calendarRepository } from "@/db/repositories";
import { ensureDatabaseReady } from "@/db/bootstrap";
import {
  CURRENT_WORKSPACE_COOKIE,
  resolveWorkspaceAndUserForRequest,
} from "@/core/workspaces/current-workspace";
import {
  AuthorizationError,
  authorizationErrorResponse,
  requireRole,
} from "@/core/workspaces/authorization";
import type { RawCalendarFilters } from "./query";
import type { CalendarFilters } from "./types";

export interface CalendarContext {
  workspaceId: string;
  /** null on desktop, where there are no users. */
  userId: string | null;
  /** Viewers read the calendar but cannot reschedule (design note §5). */
  canReschedule: boolean;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function calendarJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** The single response for any unknown or foreign filter id — never reveals existence. */
export function unknownFilterResponse(): NextResponse {
  return calendarJson({ error: "Unknown filter value." }, 400);
}

/**
 * Authorizes a calendar read. Desktop: the local workspace, may reschedule.
 * Accounts mode: 401 without a session; 403 when the cookie names a workspace
 * where the caller is suspended or removed (no silent fallback); otherwise
 * requires an active `viewer`-or-better membership in the resolved workspace.
 */
export async function resolveCalendarContext(request: NextRequest): Promise<CalendarContext | NextResponse> {
  ensureDatabaseReady();
  const resolved = await resolveWorkspaceAndUserForRequest(request);
  if (!resolved) return calendarJson({ error: "Sign-in required." }, 401);
  const { workspaceId, userId } = resolved;
  if (!userId) return { workspaceId, userId: null, canReschedule: true };

  const requested = request.cookies.get(CURRENT_WORKSPACE_COOKIE)?.value;
  if (requested) {
    const { getMembership } = await import("@/core/workspaces/service");
    const membership = await getMembership(requested, userId);
    if (membership && membership.status !== "active") {
      return authorizationErrorResponse(
        new AuthorizationError("inactive_member", "Your membership in this workspace is not active."),
      );
    }
  }

  try {
    const membership = await requireRole(workspaceId, userId, "viewer");
    return { workspaceId, userId, canReschedule: membership.role !== "viewer" };
  } catch (error) {
    if (error instanceof AuthorizationError) return authorizationErrorResponse(error);
    throw error;
  }
}

/**
 * Turns raw filter values into repository filters, validating every id
 * against the current workspace in SQL. Returns null for any unknown or
 * foreign id; the caller answers with `unknownFilterResponse()`.
 */
export async function resolveCalendarFilters(
  context: CalendarContext,
  raw: RawCalendarFilters,
): Promise<CalendarFilters | null> {
  const filters: CalendarFilters = { status: raw.status, kind: raw.kind };
  if (raw.projectId !== undefined) {
    if (!(await calendarRepository.projectExists(context.workspaceId, raw.projectId))) return null;
    filters.projectId = raw.projectId;
  }
  if (raw.assignee !== undefined) {
    // Desktop has no users, so every assignee filter is unknown there.
    if (!context.userId) return null;
    if (raw.assignee === "me") filters.assignee = { kind: "user", userId: context.userId };
    else if (raw.assignee === "unassigned") filters.assignee = { kind: "unassigned" };
    else if (await calendarRepository.memberExists(context.workspaceId, raw.assignee)) {
      filters.assignee = { kind: "user", userId: raw.assignee };
    } else return null;
  }
  return filters;
}

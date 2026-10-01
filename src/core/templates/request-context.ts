import "server-only";

/**
 * Request handling shared by the Release 2D.3 template routes
 * (docs/design/2D.3-reusable-templates.md §3–§4, §12). The workspace always
 * comes from the server-side session and active-workspace cookie — never
 * from the request.
 */
import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { CURRENT_WORKSPACE_COOKIE, resolveWorkspaceAndUserForRequest } from "@/core/workspaces/current-workspace";
import { AuthorizationError, authorizationErrorResponse, requireRole } from "@/core/workspaces/authorization";
import type { WorkspaceRole } from "@/core/workspaces/types";
import { MAX_TEMPLATE_BODY_BYTES } from "./limits";
import { TEMPLATE_ID_PATTERN } from "./schema";

export interface TemplateContext {
  workspaceId: string;
  /** null on desktop, where there are no users. */
  userId: string | null;
  /** Whether the caller may create, edit, delete and apply (member or higher; always on desktop). */
  canEdit: boolean;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function templateJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** The single answer for a malformed, nonexistent or other-workspace template id. */
export function templateNotFound(): NextResponse {
  return templateJson({ error: "Template not found" }, 404);
}

export function isTemplateId(value: string): boolean {
  return TEMPLATE_ID_PATTERN.test(value);
}

/**
 * Authorizes a template request. Desktop: the local workspace, full access.
 * Accounts mode: 401 without a session; 403 when the cookie names a workspace
 * where the caller is suspended or removed; otherwise requires an active
 * membership with at least `minimumRole`.
 */
export async function resolveTemplateContext(
  request: NextRequest,
  minimumRole: Extract<WorkspaceRole, "viewer" | "member">,
): Promise<TemplateContext | NextResponse> {
  ensureDatabaseReady();
  const resolved = await resolveWorkspaceAndUserForRequest(request);
  if (!resolved) return templateJson({ error: "Sign-in required." }, 401);
  const { workspaceId, userId } = resolved;
  if (!userId) return { workspaceId, userId: null, canEdit: true };

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
    const membership = await requireRole(workspaceId, userId, minimumRole);
    return { workspaceId, userId, canEdit: membership.role !== "viewer" };
  } catch (error) {
    if (error instanceof AuthorizationError) return authorizationErrorResponse(error);
    throw error;
  }
}

/** Parses a JSON body of at most MAX_TEMPLATE_BODY_BYTES; null when it is not valid JSON or too large. */
export async function readJsonBody(request: NextRequest): Promise<{ ok: true; value: unknown } | { ok: false; response: NextResponse }> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_TEMPLATE_BODY_BYTES) {
    return { ok: false, response: templateJson({ error: "Request body is too large." }, 413) };
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_TEMPLATE_BODY_BYTES) {
    return { ok: false, response: templateJson({ error: "Request body is too large." }, 413) };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: templateJson({ error: "Body must be JSON." }, 400) };
  }
}

/** Rejects any query string on routes that take none. */
export function hasQuery(request: NextRequest): boolean {
  return new URL(request.url).searchParams.size > 0;
}

/** SHA-256 of the canonical application request; the idempotency comparison. */
export function applicationRequestHash(templateId: string, startDate: string, name: string | undefined): string {
  return crypto.createHash("sha256").update(JSON.stringify({ templateId, startDate, name: name ?? null })).digest("hex");
}

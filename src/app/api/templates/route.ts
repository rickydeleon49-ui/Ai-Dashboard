import { NextResponse, type NextRequest } from "next/server";
import { templateRepository } from "@/db/repositories";
import { templateCreateSchema, zodIssues } from "@/core/templates/schema";
import { validateTemplate } from "@/core/templates/validate";
import { hasQuery, readJsonBody, resolveTemplateContext, templateJson } from "@/core/templates/request-context";
import { MAX_TEMPLATES_PER_WORKSPACE } from "@/core/templates/limits";

export const dynamic = "force-dynamic";

/** GET /api/templates — the current workspace's templates (any active role). */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await resolveTemplateContext(request, "viewer");
  if (context instanceof NextResponse) return context;
  if (hasQuery(request)) return templateJson({ error: "This endpoint takes no query parameters." }, 400);
  const templates = await templateRepository.list(context.workspaceId);
  return templateJson({ workspaceId: context.workspaceId, canEdit: context.canEdit, templates });
}

/**
 * POST /api/templates — create a template (member or higher). The body is a
 * full template document, or just `{ name }` for an empty template.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const context = await resolveTemplateContext(request, "member");
  if (context instanceof NextResponse) return context;
  if (hasQuery(request)) return templateJson({ error: "This endpoint takes no query parameters." }, 400);
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = templateCreateSchema.safeParse(body.value);
  if (!parsed.success) return templateJson({ error: "Invalid template.", issues: zodIssues(parsed.error) }, 400);
  const issues = validateTemplate(parsed.data);
  if (issues.length > 0) return templateJson({ error: "Invalid template.", issues }, 400);
  const result = await templateRepository.create(context.workspaceId, parsed.data, context.userId);
  if (result.kind === "limit_reached") {
    return templateJson({ error: `A workspace can have at most ${MAX_TEMPLATES_PER_WORKSPACE} templates.` }, 409);
  }
  const template = await templateRepository.get(context.workspaceId, result.id);
  return templateJson({ template }, 201);
}

import { NextResponse, type NextRequest } from "next/server";
import { templateRepository } from "@/db/repositories";
import { templateContentSchema, zodIssues } from "@/core/templates/schema";
import { validateTemplate } from "@/core/templates/validate";
import {
  hasQuery,
  isTemplateId,
  readJsonBody,
  resolveTemplateContext,
  templateJson,
  templateNotFound,
} from "@/core/templates/request-context";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** GET /api/templates/[id] — the full template (any active role). */
export async function GET(request: NextRequest, { params }: Context): Promise<NextResponse> {
  const context = await resolveTemplateContext(request, "viewer");
  if (context instanceof NextResponse) return context;
  if (hasQuery(request)) return templateJson({ error: "This endpoint takes no query parameters." }, 400);
  const { id } = await params;
  if (!isTemplateId(id)) return templateNotFound();
  const template = await templateRepository.get(context.workspaceId, id);
  if (!template) return templateNotFound();
  return templateJson({ workspaceId: context.workspaceId, canEdit: context.canEdit, template });
}

/** PUT /api/templates/[id] — replace the whole template atomically (member or higher). */
export async function PUT(request: NextRequest, { params }: Context): Promise<NextResponse> {
  const context = await resolveTemplateContext(request, "member");
  if (context instanceof NextResponse) return context;
  if (hasQuery(request)) return templateJson({ error: "This endpoint takes no query parameters." }, 400);
  const { id } = await params;
  if (!isTemplateId(id)) return templateNotFound();
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = templateContentSchema.safeParse(body.value);
  if (!parsed.success) return templateJson({ error: "Invalid template.", issues: zodIssues(parsed.error) }, 400);
  const issues = validateTemplate(parsed.data);
  if (issues.length > 0) return templateJson({ error: "Invalid template.", issues }, 400);
  if (!(await templateRepository.replace(context.workspaceId, id, parsed.data))) return templateNotFound();
  return templateJson({ template: await templateRepository.get(context.workspaceId, id) });
}

/** DELETE /api/templates/[id] — the template and its own rows only; projects created from it stay. */
export async function DELETE(request: NextRequest, { params }: Context): Promise<NextResponse> {
  const context = await resolveTemplateContext(request, "member");
  if (context instanceof NextResponse) return context;
  if (hasQuery(request)) return templateJson({ error: "This endpoint takes no query parameters." }, 400);
  const { id } = await params;
  if (!isTemplateId(id)) return templateNotFound();
  if (!(await templateRepository.delete(context.workspaceId, id))) return templateNotFound();
  return templateJson({ deleted: true });
}

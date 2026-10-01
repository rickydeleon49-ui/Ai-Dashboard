import { NextResponse, type NextRequest } from "next/server";
import { templateRepository } from "@/db/repositories";
import { isDateOnly } from "@/core/calendar/dates";
import { CalendarQueryError, toObject } from "@/core/calendar/query";
import { MAX_PROJECT_NAME } from "@/core/templates/limits";
import { previewTemplate } from "@/core/templates/validate";
import { isTemplateId, resolveTemplateContext, templateJson, templateNotFound } from "@/core/templates/request-context";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * GET /api/templates/[id]/preview?startDate=YYYY-MM-DD[&name=…]
 *
 * Server-computed preview of applying the template (any active role). Reads
 * only: no rows are created or changed.
 */
export async function GET(request: NextRequest, { params }: Context): Promise<NextResponse> {
  const context = await resolveTemplateContext(request, "viewer");
  if (context instanceof NextResponse) return context;

  let raw: Record<string, string>;
  try {
    raw = toObject(new URL(request.url).searchParams, ["startDate", "name"]);
  } catch (error) {
    if (error instanceof CalendarQueryError) return templateJson({ error: error.message }, 400);
    throw error;
  }
  if (!isDateOnly(raw.startDate)) {
    return templateJson({ error: "'startDate' must be a valid YYYY-MM-DD date between 1900-01-01 and 9999-12-31." }, 400);
  }
  let name: string | undefined;
  if (raw.name !== undefined) {
    name = raw.name.trim();
    if (name.length === 0 || name.length > MAX_PROJECT_NAME) {
      return templateJson({ error: `'name' must be 1–${MAX_PROJECT_NAME} characters.` }, 400);
    }
  }

  const { id } = await params;
  if (!isTemplateId(id)) return templateNotFound();
  const template = await templateRepository.get(context.workspaceId, id);
  if (!template) return templateNotFound();
  return templateJson({
    workspaceId: context.workspaceId,
    canApply: context.canEdit,
    preview: previewTemplate(template.id, template, raw.startDate, name),
  });
}

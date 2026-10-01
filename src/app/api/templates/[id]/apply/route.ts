import { NextResponse, type NextRequest } from "next/server";
import { templateRepository } from "@/db/repositories";
import { templateApplySchema, zodIssues } from "@/core/templates/schema";
import {
  applicationRequestHash,
  hasQuery,
  isTemplateId,
  readJsonBody,
  resolveTemplateContext,
  templateJson,
  templateNotFound,
} from "@/core/templates/request-context";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * POST /api/templates/[id]/apply — create the complete project in one
 * transaction (member or higher). Body: { idempotencyKey, startDate, name? }.
 * The same key and request returns the already-created project; the same key
 * with a different request is a 409. See docs/design/2D.3-reusable-templates.md §9–§10.
 */
export async function POST(request: NextRequest, { params }: Context): Promise<NextResponse> {
  const context = await resolveTemplateContext(request, "member");
  if (context instanceof NextResponse) return context;
  if (hasQuery(request)) return templateJson({ error: "This endpoint takes no query parameters." }, 400);
  const { id } = await params;
  if (!isTemplateId(id)) return templateNotFound();

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = templateApplySchema.safeParse(body.value);
  if (!parsed.success) return templateJson({ error: "Invalid request.", issues: zodIssues(parsed.error) }, 400);
  const { idempotencyKey, startDate, name } = parsed.data;

  const result = await templateRepository.apply(
    context.workspaceId,
    id,
    { idempotencyKey, startDate, name, requestHash: applicationRequestHash(id, startDate, name) },
    { userId: context.userId, actorKey: context.userId ?? "local" },
  );

  switch (result.kind) {
    case "created":
      return templateJson(
        { created: true, project: result.project, milestones: result.milestones, tasks: result.tasks },
        201,
      );
    case "replayed":
      return templateJson({ created: false, project: result.project });
    case "conflict":
      return templateJson(
        {
          error:
            result.reason === "different_request"
              ? "This request key was already used for a different request."
              : "The project this request created has since been deleted.",
        },
        409,
      );
    case "not_found":
      return templateNotFound();
    case "forbidden":
      return templateJson({ error: "You do not have permission to create projects in this workspace." }, 403);
    case "invalid":
      return templateJson({ error: "This template cannot be applied.", issues: result.issues }, 422);
  }
}

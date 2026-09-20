import { NextResponse, type NextRequest } from "next/server";
import { taskRepository } from "@/db/repositories";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { myWorkQuerySchema } from "@/core/tasks/schema";
import { serializeTaskResponse } from "@/core/tasks/serialize";
import type { TaskQuery } from "@/core/tasks/types";
import { resolveWorkspaceAndUserForRequest } from "@/core/workspaces/current-workspace";

export const dynamic = "force-dynamic";

function workspaceRequiredResponse(): NextResponse {
  return NextResponse.json(
    { error: "Sign-in required." },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * GET /api/my-work — every task across the caller's current workspace,
 * scoped to their own assignment in accounts mode (`userId` set) by default,
 * or filtered by `unassigned`, `assignedTo`, or `assignedBy`.
 * On desktop and single-password hosted mode there is no user concept at all
 * (`userId` is always null there, see `resolveWorkspaceAndUserForRequest`),
 * so "my work" there means every task in the one workspace that exists.
 */
export async function GET(request: NextRequest) {
  ensureDatabaseReady();
  const resolved = await resolveWorkspaceAndUserForRequest(request);
  if (!resolved) return workspaceRequiredResponse();
  const { workspaceId, userId } = resolved;

  const url = new URL(request.url);
  const parsed = myWorkQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const query: TaskQuery = {
    status: parsed.data.status,
    priority: parsed.data.priority,
    sort: parsed.data.sort,
    limit: parsed.data.limit,
    unassigned: parsed.data.unassigned,
  };

  if (parsed.data.assignedTo) {
    const target = parsed.data.assignedTo === "me" ? (userId ?? undefined) : parsed.data.assignedTo;
    query.assignedTo = target;
    query.assigneeId = target;
  }

  if (parsed.data.assignedBy) {
    const assigner = parsed.data.assignedBy === "me" ? (userId ?? undefined) : parsed.data.assignedBy;
    query.assignedBy = assigner;
  }

  // In accounts mode, default to tasks assigned to the caller if no assignment filter is specified
  if (userId && !parsed.data.unassigned && !parsed.data.assignedTo && !parsed.data.assignedBy) {
    query.assignedTo = userId;
    query.assigneeId = userId;
  }

  const tasks = await taskRepository.listForWorkspace(workspaceId, query);
  return NextResponse.json({ tasks: tasks.map(serializeTaskResponse) });
}

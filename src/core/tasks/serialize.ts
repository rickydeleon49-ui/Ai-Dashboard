import type { Task } from "./types";
import { isAccountsMode } from "@/lib/auth-mode";

/**
 * Serializes a task for API responses.
 *
 * In accounts mode, assignedBy and assignedAt are explicitly included.
 * In desktop / single-password mode, assignedBy and assignedAt are excluded
 * to preserve the legacy desktop response shape.
 */
export function serializeTaskResponse(task: Task): Record<string, unknown> {
  if (isAccountsMode()) {
    return {
      ...task,
      assignedBy: task.assignedBy ?? null,
      assignedAt: task.assignedAt ?? null,
    };
  }

  const { assignedBy: _by, assignedAt: _at, ...rest } = task;
  return rest;
}

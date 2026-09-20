/**
 * Thrown by `TaskRepository.addDependency()` when the requested edge would
 * close a cycle in the dependency graph (directly — a task depending on
 * itself — or transitively through any chain of existing dependencies).
 * Rejected before the row is ever written; see each implementation's own
 * comment for how the check is made.
 */
export class DependencyCycleError extends Error {
  constructor() {
    super("Adding this dependency would create a cycle.");
    this.name = "DependencyCycleError";
  }
}

/**
 * Thrown by `TaskRepository.update()` when asked to move a task to `done`
 * while it is still blocked (has a direct dependency whose own status
 * isn't done/cancelled). Rejected rather than silently allowed: a blocked
 * task marked done anyway would make `loadBlockedSet`'s own transitive-
 * blocking argument false for whatever depends on it — see that function's
 * comment in each repository implementation. `cancelled` is not gated the
 * same way; abandoning blocked work is a normal thing to do.
 */
export class TaskBlockedError extends Error {
  constructor() {
    super("This task is still blocked by an unfinished dependency and cannot be marked done.");
    this.name = "TaskBlockedError";
  }
}

/**
 * Thrown when a task's parentTaskId violates hierarchy invariants:
 * - A parent task must be a top-level task (not a child itself).
 * - A task with existing children cannot become a child.
 * - Self-parenting and parent cycles are forbidden.
 * - A parent task must exist within the same workspace and project.
 */
export class InvalidParentTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidParentTaskError";
  }
}

/**
 * Thrown when an assigneeId is not an active member of the task's workspace,
 * or when an assignee is specified in a mode (such as desktop SQLite) that
 * does not support task assignments.
 */
export class InvalidAssigneeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAssigneeError";
  }
}

/**
 * Thrown when a concurrent transaction times out waiting for the workspace-scoped
 * advisory lock during dependency graph or hierarchy mutations.
 * Indicates a temporary concurrency conflict that is safe to retry.
 */
export class TaskLockTimeoutError extends Error {
  constructor(message = "Task mutation timed out waiting for workspace lock; please retry.") {
    super(message);
    this.name = "TaskLockTimeoutError";
  }
}

/**
 * Thrown when a task's checklist reaches the maximum limit (100 items).
 */
export class ChecklistLimitExceededError extends Error {
  constructor(message = "Task checklist cannot exceed 100 items.") {
    super(message);
    this.name = "ChecklistLimitExceededError";
  }
}

/**
 * Thrown when a checklist item is not found or does not belong to the given task/workspace.
 */
export class ChecklistItemNotFoundError extends Error {
  constructor(message = "Checklist item not found.") {
    super(message);
    this.name = "ChecklistItemNotFoundError";
  }
}

/**
 * Thrown when checklist item input violates validation rules (e.g. text length, empty text, or invalid reorder IDs).
 */
export class InvalidChecklistItemError extends Error {
  constructor(message = "Checklist item text must be between 1 and 500 characters.") {
    super(message);
    this.name = "InvalidChecklistItemError";
  }
}

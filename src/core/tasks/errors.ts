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

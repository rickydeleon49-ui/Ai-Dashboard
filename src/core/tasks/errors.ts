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

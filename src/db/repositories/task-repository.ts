/**
 * The persistence contract for tasks — mirrors `./project-repository.ts`'s
 * own shape and reasoning exactly. Everything above this line depends only
 * on this interface, never on Drizzle or a specific database directly.
 */
import type { Task, TaskCreateInput, TaskQuery, TaskUpdateInput } from "@/core/tasks/types";

/**
 * `workspaceId` is a mandatory first parameter on every method, matching
 * `ProjectRepository` — explicit and grep-able, impossible to silently
 * forget at a call site. `DrizzleTaskRepository` (SQLite) only ever accepts
 * `LOCAL_WORKSPACE_ID` (re-exported from `./project-repository`) and throws
 * on anything else; `PostgresTaskRepository` genuinely scopes every query
 * to it.
 */
export interface TaskRepository {
  /** Tasks within one project. */
  list(workspaceId: string, projectId: string, query?: TaskQuery): Promise<Task[]>;
  /**
   * Tasks across every project in the workspace — what "My Work" and a
   * project-agnostic task list need. `query.assigneeId` set filters to that
   * assignment (accounts mode's "assigned to me"); omitted, it returns
   * every task in the workspace (desktop's "my work", since there is only
   * ever one user there).
   */
  listForWorkspace(workspaceId: string, query?: TaskQuery): Promise<Task[]>;
  findById(workspaceId: string, id: string): Promise<Task | null>;
  create(workspaceId: string, input: TaskCreateInput): Promise<Task>;
  update(workspaceId: string, id: string, input: TaskUpdateInput): Promise<Task | null>;
  delete(workspaceId: string, id: string): Promise<boolean>;

  /** Tasks `taskId` depends on — must reach done/cancelled before it can. */
  listBlockers(workspaceId: string, taskId: string): Promise<Task[]>;
  /** Tasks that depend on `taskId` — blocked until it reaches done/cancelled. */
  listDependents(workspaceId: string, taskId: string): Promise<Task[]>;
  /**
   * Records that `taskId` cannot be done until `dependsOnTaskId` is.
   * Idempotent (adding the same edge twice is a no-op). Rejects with
   * `DependencyCycleError` (see `core/tasks/errors.ts`) — including for
   * `taskId === dependsOnTaskId` — without writing anything.
   */
  addDependency(workspaceId: string, taskId: string, dependsOnTaskId: string): Promise<void>;
  /** Idempotent — removing an edge that doesn't exist is a no-op. */
  removeDependency(workspaceId: string, taskId: string, dependsOnTaskId: string): Promise<void>;
}

/**
 * Core planning domain types (Phase 2, release A): milestones and tasks.
 *
 * Single source of truth for what a milestone/task is anywhere in the
 * application — mirrors `core/projects/types.ts`'s own conventions exactly.
 * A field earns a column when it's queried or filtered directly; anything
 * more open-ended belongs in `description`, not a new column.
 */

export const MILESTONE_STATUSES = ["open", "completed", "cancelled"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export interface Milestone {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: MilestoneStatus;
  /** ISO date/time, or null if the milestone has no target date. */
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type MilestoneCreateInput = Partial<Omit<Milestone, "id">> & {
  projectId: string;
  title: string;
};

/** Fields a caller may change. `projectId` and `createdAt` are immutable. */
export type MilestoneUpdateInput = Partial<Omit<Milestone, "id" | "projectId" | "createdAt">>;

export interface MilestoneQuery {
  status?: MilestoneStatus | "all";
}

export const TASK_STATUSES = ["todo", "in_progress", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface Task {
  id: string;
  projectId: string;
  milestoneId: string | null;
  /** One level of subtasking is all the UI renders; the schema allows more. */
  parentTaskId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  /**
   * Meaningless on desktop — there is no user concept there, so
   * `DrizzleTaskRepository` always reads/writes this as `null`. Real in
   * hosted accounts mode, where it references a workspace member.
   */
  assigneeId: string | null;
  /**
   * User ID of the workspace member who created or updated the assignment.
   * Null for unassigned or legacy tasks.
   */
  assignedBy: string | null;
  /** ISO date/time string when the assignment was made, or null. */
  assignedAt: string | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /**
   * True iff this task has at least one dependency (see
   * `TaskRepository.addDependency`) whose own status isn't done/cancelled.
   * Always computed fresh at read time from `task_dependencies` — never
   * stored — so it can never drift out of sync with the dependency graph
   * or the blocker's own status. Not settable via create/update input.
   */
  blocked: boolean;
  /** Total number of checklist items on this task. */
  checklistTotal: number;
  /** Number of completed checklist items on this task. */
  checklistDone: number;
}

export type TaskCreateInput = Partial<
  Omit<Task, "id" | "blocked" | "checklistDone" | "checklistTotal">
> & {
  projectId: string;
  title: string;
};

/**
 * Fields a caller may change. `projectId`, `createdAt` and `blocked` are
 * immutable — `blocked` only ever changes as a side effect of
 * `addDependency`/`removeDependency` or a dependency's own status changing.
 */
export type TaskUpdateInput = Partial<
  Omit<Task, "id" | "projectId" | "createdAt" | "blocked" | "checklistDone" | "checklistTotal">
>;

export interface TaskMutationOptions {
  actorUserId?: string;
}

export interface TaskUpdateOutcome {
  task: Task;
  unchanged: boolean;
}

export interface TaskQuery {
  status?: TaskStatus | "all";
  priority?: TaskPriority | "all";
  milestoneId?: string;
  assigneeId?: string;
  unassigned?: boolean;
  assignedTo?: string;
  assignedBy?: string;
  /** `null` means "top-level tasks only"; omitted means "no filter". */
  parentTaskId?: string | null;
  sort?: "dueDate" | "priority" | "created" | "updated";
  limit?: number;
}

export type BulkTaskErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid_assignee"
  | "invalid_milestone"
  | "blocked_task"
  | "validation_failed"
  | "conflict"
  | "internal_error";

export type BulkTaskResultStatus = "updated" | "unchanged" | "failed";

export interface BulkTaskItemResult {
  taskId: string;
  status: BulkTaskResultStatus;
  errorCode?: BulkTaskErrorCode;
  error?: string;
  retryable?: boolean;
}

export interface BulkTaskChanges {
  status?: TaskStatus;
  priority?: TaskPriority;
  milestoneId?: string | null;
  assigneeId?: string | null;
  dueDate?: string | null;
}

export interface BulkTaskUpdateRequest {
  taskIds: string[];
  changes: BulkTaskChanges;
}

export interface BulkTaskUpdateResponse {
  requested: number;
  succeeded: number;
  updated: number;
  unchanged: number;
  failed: number;
  results: BulkTaskItemResult[];
}

export * from "./checklist-types";
export * from "./comment-types";

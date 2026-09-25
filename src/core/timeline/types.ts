/** Release 2D.2 timeline domain types. See docs/design/2D.2-timeline.md. */
import type { DateOnly } from "@/core/calendar/dates";

export const TIMELINE_ZOOMS = ["week", "month", "quarter"] as const;
export type TimelineZoom = (typeof TIMELINE_ZOOMS)[number];

/** Every window is at most 15 ISO weeks (a quarter padded to whole weeks). */
export const MAX_TIMELINE_DAYS = 105;
export const MAX_TIMELINE_TASKS = 400;
export const MAX_TIMELINE_MILESTONES = 100;
export const MAX_TIMELINE_UNDATED_TASKS = 200;
export const MAX_TIMELINE_UNDATED_MILESTONES = 50;
export const MAX_TIMELINE_EDGES = 1000;
/** Tasks per dependency-exploration statement. */
export const TIMELINE_EXPLORE_BATCH = 50;
/** Levels of the breadth-first explanation walk. */
export const MAX_TIMELINE_DEPTH = 32;
/** Reachable tasks the exact blocked-state analysis may visit before refusing. */
export const MAX_TIMELINE_ANALYSIS_TASKS = 50_000;
/** PostgreSQL statement_timeout for the whole timeline read (ms). */
export const TIMELINE_STATEMENT_TIMEOUT_MS = 3000;

export interface TimelineLimits {
  tasks: number;
  milestones: number;
  undatedTasks: number;
  undatedMilestones: number;
  /** Dependency rows loaded to explain blocking (the explanation budget). */
  edges: number;
  exploreBatch: number;
  maxDepth: number;
  /** Reachable tasks the blocked-state analysis may visit. */
  analysisTasks: number;
  /** PostgreSQL only. */
  statementTimeoutMs: number;
}

export const TIMELINE_LIMITS: TimelineLimits = {
  tasks: MAX_TIMELINE_TASKS,
  milestones: MAX_TIMELINE_MILESTONES,
  undatedTasks: MAX_TIMELINE_UNDATED_TASKS,
  undatedMilestones: MAX_TIMELINE_UNDATED_MILESTONES,
  edges: MAX_TIMELINE_EDGES,
  exploreBatch: TIMELINE_EXPLORE_BATCH,
  maxDepth: MAX_TIMELINE_DEPTH,
  analysisTasks: MAX_TIMELINE_ANALYSIS_TASKS,
  statementTimeoutMs: TIMELINE_STATEMENT_TIMEOUT_MS,
};

/** A task row as the repository returns it (before blocking analysis). */
export interface TimelineTaskRow {
  id: string;
  title: string;
  status: string;
  /** Calendar day of the due date, or null when undated. */
  date: DateOnly | null;
  milestoneId: string | null;
  milestoneTitle: string | null;
  /** The milestone's target day (null when it has none). */
  milestoneDate: DateOnly | null;
  /** Always null on desktop, where there are no users. */
  assigneeId: string | null;
  /**
   * Exact blocked state (canonical definition, computed over the whole
   * reachable graph by the repository) — never derived from the capped
   * explanation graph.
   */
  blocked: boolean;
}

export interface TimelineMilestoneRow {
  id: string;
  title: string;
  status: string;
  date: DateOnly | null;
}

/** A task referenced by a dependency edge but not itself a returned item. */
export interface TimelineExternalTask {
  id: string;
  title: string;
  status: string;
  date: DateOnly | null;
  projectId: string;
  projectName: string;
}

/** `taskId` cannot finish until `dependsOnTaskId` is resolved. */
export interface TimelineEdge {
  taskId: string;
  dependsOnTaskId: string;
}

export interface TimelineData {
  project: { id: string; name: string };
  tasks: TimelineTaskRow[];
  milestones: TimelineMilestoneRow[];
  undatedTasks: TimelineTaskRow[];
  undatedMilestones: TimelineMilestoneRow[];
  /** Explanation graph: a bounded breadth-first part of the reachable subgraph (workspace-scoped). */
  edges: TimelineEdge[];
  /** Tasks whose dependencies are all present in `edges`. */
  expanded: string[];
  /** Edge endpoints that are not returned tasks. */
  external: TimelineExternalTask[];
  truncated: {
    tasks: boolean;
    milestones: boolean;
    undatedTasks: boolean;
    undatedMilestones: boolean;
    edges: boolean;
  };
}

export type TimelineConflict = "due_before_blocker" | "due_after_milestone";

export interface TimelineBlocking {
  /** Direct dependencies that lie on the blocking path, in visit order. */
  immediateBlockers: string[];
  /** Unfinished tasks reachable from this task, in visit order. */
  roots: string[];
  /** Edges of the blocking path, as [taskId, dependsOnTaskId]. */
  path: [string, string][];
  /**
   * False when the explanation graph was cut off before this task's whole
   * dependency graph was loaded: roots and path are then partial (possibly
   * empty) while `blocked` stays exact.
   */
  complete: boolean;
}

export interface TimelineTaskItem extends TimelineTaskRow {
  kind: "task";
  /** Every direct dependency id (resolved or not), in visit order. */
  dependsOn: string[];
  blocking: TimelineBlocking;
  conflicts: TimelineConflict[];
}

export interface TimelineMilestoneItem extends TimelineMilestoneRow {
  kind: "milestone";
}

export type TimelineItem = TimelineTaskItem | TimelineMilestoneItem;

export interface TimelineNode {
  id: string;
  title: string;
  status: string;
  date: DateOnly | null;
  projectId: string;
  projectName: string;
  /** True when the node belongs to the timeline's own project. */
  inProject: boolean;
}

export interface TimelineResponse {
  workspaceId: string;
  projectId: string;
  projectName: string;
  zoom: TimelineZoom;
  anchor: DateOnly;
  from: DateOnly;
  to: DateOnly;
  timeZone: string;
  today: DateOnly;
  /** Dated items in the window, in timeline order. */
  items: TimelineItem[];
  /** Undated tasks (with any milestone target) and undated milestones. */
  undated: TimelineItem[];
  /** Every task any edge references, keyed by id (items, undated and external). */
  nodes: Record<string, TimelineNode>;
  edges: TimelineEdge[];
  /** Accounts mode only: display names for assignees. Never emails. */
  assignees: { id: string; name: string | null }[];
  limits: TimelineLimits;
  truncated: TimelineData["truncated"];
  /** Always false in this release: the timeline is read-only for every role. */
  editable: false;
}

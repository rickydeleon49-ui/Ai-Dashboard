/**
 * Release 2D.2 blocking-path analysis (docs/design/2D.2-timeline.md §6).
 *
 * Pure and framework-free. It never decides whether a task is blocked —
 * `blocked` is computed exactly by the timeline repository over the whole
 * reachable graph (the canonical definition) — it only explains the block:
 * which unfinished tasks are responsible (roots) and the deterministic
 * chain(s) of dependencies leading to them (path), within the bounded
 * explanation graph.
 *
 * Traversal follows edges through resolved tasks too, as the canonical
 * definition does, so a completed task cannot hide an unfinished transitive
 * blocker. A visited set makes cycles harmless and every walk is bounded by
 * the (capped) edge list it is given.
 */
import type { DateOnly } from "@/core/calendar/dates";
import type {
  TimelineBlocking,
  TimelineConflict,
  TimelineData,
  TimelineEdge,
  TimelineItem,
  TimelineMilestoneItem,
  TimelineNode,
  TimelineTaskItem,
  TimelineTaskRow,
} from "./types";

/** The task repositories' rule (`DONE_STATUSES`): only these statuses release a dependent. */
const TASK_RESOLVED = new Set(["done", "cancelled"]);

export function isTaskResolved(status: string): boolean {
  return TASK_RESOLVED.has(status);
}

/** For display: a task is done/cancelled, a milestone completed/cancelled. */
export function isItemResolved(kind: "task" | "milestone", status: string): boolean {
  return kind === "task" ? isTaskResolved(status) : status === "completed" || status === "cancelled";
}

interface NodeLike {
  id: string;
  title: string;
  date: DateOnly | null;
}

/** Visit order: due day ascending (undated last), then title, then id. */
export function compareNodes(a: NodeLike, b: NodeLike): number {
  if (a.date !== b.date) {
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date < b.date ? -1 : 1;
  }
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Timeline order for dated items: day, milestones before tasks, title, id. */
export function compareDatedItems(a: TimelineItem, b: TimelineItem): number {
  if (a.date !== b.date) return (a.date ?? "") < (b.date ?? "") ? -1 : 1;
  if (a.kind !== b.kind) return a.kind === "milestone" ? -1 : 1;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Undated section: tasks by milestone target (none last), title, id; then milestones. */
export function compareUndatedItems(a: TimelineItem, b: TimelineItem): number {
  if (a.kind !== b.kind) return a.kind === "task" ? -1 : 1;
  if (a.kind === "task" && b.kind === "task" && a.milestoneDate !== b.milestoneDate) {
    if (a.milestoneDate === null) return 1;
    if (b.milestoneDate === null) return -1;
    return a.milestoneDate < b.milestoneDate ? -1 : 1;
  }
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Adjacency list `taskId → dependsOn[]`, each list in visit order. */
export function buildDependencyGraph(edges: TimelineEdge[], nodes: Map<string, NodeLike>): Map<string, string[]> {
  const graph = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!graph.has(e.taskId)) graph.set(e.taskId, new Set());
    graph.get(e.taskId)!.add(e.dependsOnTaskId);
  }
  const fallback = (id: string): NodeLike => ({ id, title: "", date: null });
  const ordered = new Map<string, string[]>();
  for (const [taskId, deps] of graph) {
    ordered.set(
      taskId,
      [...deps].sort((x, y) => compareNodes(nodes.get(x) ?? fallback(x), nodes.get(y) ?? fallback(y))),
    );
  }
  return ordered;
}

/**
 * Explains why `taskId` is blocked. Breadth-first from the task over its
 * dependencies (neighbours in visit order); every unfinished task reached is
 * a root, and the path is the union of the BFS-tree paths to the roots —
 * shortest by edge count, ties broken by visit order, all branches included.
 * A node whose status is unknown (outside a truncated edge set) is never
 * claimed as a root. `complete` is false when the walk reaches a task whose
 * dependencies were not all loaded (`isExpanded`), so the explanation may be
 * partial.
 */
export function blockingFor(
  taskId: string,
  graph: Map<string, string[]>,
  statusOf: (id: string) => string | undefined,
  isExpanded: (id: string) => boolean = () => true,
): TimelineBlocking {
  const parent = new Map<string, string>();
  const visited = new Set<string>([taskId]);
  const order: string[] = [];
  const queue: string[] = [taskId];
  let complete = true;
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!;
    if (!isExpanded(current)) complete = false;
    for (const dep of graph.get(current) ?? []) {
      if (visited.has(dep)) continue;
      visited.add(dep);
      parent.set(dep, current);
      order.push(dep);
      queue.push(dep);
    }
  }

  const roots = order.filter((id) => {
    const status = statusOf(id);
    return status !== undefined && !isTaskResolved(status);
  });

  const onPath = new Set<string>();
  const path: [string, string][] = [];
  for (const root of roots) {
    const chain: [string, string][] = [];
    let child = root;
    while (child !== taskId) {
      const from = parent.get(child)!;
      const key = `${from}\u0000${child}`;
      if (onPath.has(key)) break;
      onPath.add(key);
      chain.push([from, child]);
      child = from;
    }
    path.push(...chain.reverse());
  }

  const immediateBlockers = (graph.get(taskId) ?? []).filter((dep) => onPath.has(`${taskId}\u0000${dep}`));
  return { immediateBlockers, roots, path, complete };
}

function conflictsFor(
  task: TimelineTaskRow,
  deps: string[],
  nodeOf: (id: string) => NodeLike & { status: string } | undefined,
): TimelineConflict[] {
  if (isTaskResolved(task.status) || task.date === null) return [];
  const conflicts: TimelineConflict[] = [];
  const dueBeforeBlocker = deps.some((id) => {
    const dep = nodeOf(id);
    return dep !== undefined && !isTaskResolved(dep.status) && dep.date !== null && dep.date > task.date!;
  });
  if (dueBeforeBlocker) conflicts.push("due_before_blocker");
  if (task.milestoneDate !== null && task.date > task.milestoneDate) conflicts.push("due_after_milestone");
  return conflicts;
}

export interface TimelineAnalysis {
  items: TimelineItem[];
  undated: TimelineItem[];
  nodes: Record<string, TimelineNode>;
  edges: TimelineEdge[];
}

/** Turns repository rows into ordered timeline items with blocking and conflicts. */
export function analyzeTimeline(data: TimelineData): TimelineAnalysis {
  const nodes: Record<string, TimelineNode> = {};
  const addTask = (t: TimelineTaskRow) => {
    nodes[t.id] = {
      id: t.id,
      title: t.title,
      status: t.status,
      date: t.date,
      projectId: data.project.id,
      projectName: data.project.name,
      inProject: true,
    };
  };
  data.tasks.forEach(addTask);
  data.undatedTasks.forEach(addTask);
  for (const x of data.external) {
    if (nodes[x.id]) continue;
    nodes[x.id] = { ...x, inProject: x.projectId === data.project.id };
  }

  const nodeMap = new Map(Object.values(nodes).map((n) => [n.id, n]));
  const graph = buildDependencyGraph(data.edges, nodeMap);
  const statusOf = (id: string) => nodeMap.get(id)?.status;
  const expanded = new Set(data.expanded);
  const isExpanded = (id: string) => expanded.has(id);

  const toTask = (row: TimelineTaskRow): TimelineTaskItem => {
    const dependsOn = graph.get(row.id) ?? [];
    return {
      kind: "task",
      ...row,
      dependsOn,
      blocking: row.blocked
        ? blockingFor(row.id, graph, statusOf, isExpanded)
        : { immediateBlockers: [], roots: [], path: [], complete: blockingFor(row.id, graph, statusOf, isExpanded).complete },
      conflicts: conflictsFor(row, dependsOn, (id) => nodeMap.get(id)),
    };
  };
  const toMilestone = (row: TimelineData["milestones"][number]): TimelineMilestoneItem => ({ kind: "milestone", ...row });

  const items: TimelineItem[] = [...data.tasks.map(toTask), ...data.milestones.map(toMilestone)].sort(compareDatedItems);
  const undated: TimelineItem[] = [...data.undatedTasks.map(toTask), ...data.undatedMilestones.map(toMilestone)].sort(
    compareUndatedItems,
  );

  const edges = [...data.edges].sort((a, b) =>
    a.taskId !== b.taskId
      ? a.taskId < b.taskId ? -1 : 1
      : a.dependsOnTaskId < b.dependsOnTaskId ? -1 : a.dependsOnTaskId > b.dependsOnTaskId ? 1 : 0,
  );
  return { items, undated, nodes, edges };
}

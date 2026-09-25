/**
 * Release 2D.2 bounded dependency exploration (docs/design/2D.2-timeline.md §7).
 *
 * Loads the dependency graph that EXPLAINS blocking — never the blocked
 * state itself — breadth-first from the returned tasks, with hard limits on
 * database work that hold for any graph shape:
 *
 * - each statement asks for at most `batchSize` tasks' dependencies, and at
 *   most `remaining + 1` dependency rows per task (an ordered, LIMITed index
 *   range scan on the `(task_id, depends_on_task_id)` primary key);
 * - a statement whose rows all fit in the budget is fully consumed, so all
 *   such statements together read at most `edgeBudget` rows; the first
 *   statement that does not fit ends the walk, and it read at most
 *   `batchSize × (edgeBudget + 1)` rows;
 * - at most `maxDepth` levels are walked.
 *
 * So rows read ≤ edgeBudget + batchSize × (edgeBudget + 1), and statements ≤
 * ceil(seeds / batchSize) + ceil(edgeBudget / batchSize) + maxDepth,
 * whatever the size of the workspace graph. A visited set makes cycles
 * terminate. The walk is deterministic: frontiers and rows are ordered by id.
 */
import type { TimelineEdge } from "./types";

/** Loads, for each id in `ids` (in order), at most `perTaskLimit` dependency ids, ascending. */
export type DependencyBatchLoader = (ids: string[], perTaskLimit: number) => Promise<TimelineEdge[]>;

export interface ExploreBudget {
  edgeBudget: number;
  batchSize: number;
  maxDepth: number;
}

export interface ExploreResult {
  /** At most `edgeBudget` edges, in walk order. */
  edges: TimelineEdge[];
  /** Tasks whose dependencies were loaded completely. */
  expanded: string[];
  /** True when the budget or depth limit stopped the walk before it finished. */
  truncated: boolean;
  /** Statements issued (for tests and diagnostics). */
  statements: number;
  /** Rows the database returned (for tests and diagnostics). */
  rowsRead: number;
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export async function exploreDependencies(
  seeds: string[],
  budget: ExploreBudget,
  load: DependencyBatchLoader,
): Promise<ExploreResult> {
  const visited = new Set(seeds);
  const expanded: string[] = [];
  const edges: TimelineEdge[] = [];
  let frontier = [...visited].sort(byId);
  let truncated = false;
  let statements = 0;
  let rowsRead = 0;

  for (let depth = 0; frontier.length > 0; depth++) {
    if (depth >= budget.maxDepth) {
      truncated = true;
      break;
    }
    const next: string[] = [];
    for (let i = 0; i < frontier.length && !truncated; i += budget.batchSize) {
      const remaining = budget.edgeBudget - edges.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const batch = frontier.slice(i, i + budget.batchSize);
      const rows = await load(batch, remaining + 1);
      statements++;
      rowsRead += rows.length;
      const rowsOf = new Map<string, string[]>();
      for (const r of rows) {
        if (!rowsOf.has(r.taskId)) rowsOf.set(r.taskId, []);
        rowsOf.get(r.taskId)!.push(r.dependsOnTaskId);
      }
      for (const id of batch) {
        // Sorted here, so output order never depends on how the database interleaves rows.
        const deps = (rowsOf.get(id) ?? []).sort(byId);
        const room = budget.edgeBudget - edges.length;
        if (deps.length > room) {
          // Take what fits; this task is not fully expanded, and the walk ends.
          for (const dep of deps.slice(0, room)) edges.push({ taskId: id, dependsOnTaskId: dep });
          truncated = true;
          break;
        }
        for (const dep of deps) {
          edges.push({ taskId: id, dependsOnTaskId: dep });
          if (!visited.has(dep)) {
            visited.add(dep);
            next.push(dep);
          }
        }
        expanded.push(id);
      }
    }
    if (truncated) break;
    frontier = next.sort(byId);
  }

  return { edges, expanded, truncated, statements, rowsRead };
}

/**
 * Thrown when the exact blocked-state analysis would exceed its workload
 * guard (too many reachable tasks, or PostgreSQL's statement timeout). The
 * route answers with a generic, retryable 503; blocked state is never guessed.
 */
export class TimelineAnalysisBudgetError extends Error {
  constructor() {
    super("The dependency graph is too large to analyse.");
    this.name = "TimelineAnalysisBudgetError";
  }
}

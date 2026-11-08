/**
 * Pure functions for picking the next eligible task and extracting
 * checklist items from markdown sections (AW4-02).
 */

export interface NextTaskCandidate {
  id: string;
  parentTaskId: string | null;
  title: string;
  status: string; // "todo" | "in_progress" | "done" | "cancelled"
  priority: string; // "urgent" | "high" | "medium" | "low"
  dueDate: string | null; // ISO date or null
  createdAt: string; // ISO timestamp
}

export interface TaskDependencyEdge {
  taskId: string;
  dependsOnTaskId: string;
}

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function getPriorityRank(priority: string): number {
  const rank = PRIORITY_ORDER[priority];
  return rank !== undefined ? rank : 4;
}

function compareCandidates(a: NextTaskCandidate, b: NextTaskCandidate): number {
  // 1. Priority: urgent > high > medium > low (unknown priority sorts after low)
  const rankA = getPriorityRank(a.priority);
  const rankB = getPriorityRank(b.priority);
  if (rankA !== rankB) {
    return rankA - rankB;
  }

  // 2. Due date: earliest first, null last
  if (a.dueDate !== null && b.dueDate !== null) {
    if (a.dueDate !== b.dueDate) {
      return a.dueDate < b.dueDate ? -1 : 1;
    }
  } else if (a.dueDate !== null && b.dueDate === null) {
    return -1;
  } else if (a.dueDate === null && b.dueDate !== null) {
    return 1;
  }

  // 3. CreatedAt: earliest first
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }

  // 4. Id: ascending
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }

  return 0;
}

/**
 * Returns all tasks that are eligible to run, sorted by priority, due date, createdAt, and id.
 */
export function eligibleTasks(
  tasks: NextTaskCandidate[],
  deps: TaskDependencyEdge[],
  activeRunTaskIds: ReadonlySet<string>,
): NextTaskCandidate[] {
  const taskById = new Map<string, NextTaskCandidate>();
  const subtasksByParentId = new Map<string, NextTaskCandidate[]>();

  for (const task of tasks) {
    taskById.set(task.id, task);
    if (task.parentTaskId !== null) {
      const list = subtasksByParentId.get(task.parentTaskId);
      if (list) {
        list.push(task);
      } else {
        subtasksByParentId.set(task.parentTaskId, [task]);
      }
    }
  }

  const depsByTaskId = new Map<string, string[]>();
  for (const edge of deps) {
    const list = depsByTaskId.get(edge.taskId);
    if (list) {
      list.push(edge.dependsOnTaskId);
    } else {
      depsByTaskId.set(edge.taskId, [edge.dependsOnTaskId]);
    }
  }

  const result: NextTaskCandidate[] = [];

  for (const task of tasks) {
    // Only status "todo"
    if (task.status !== "todo") {
      continue;
    }

    // Not in activeRunTaskIds
    if (activeRunTaskIds.has(task.id)) {
      continue;
    }

    // Blocked if it has a dependency edge whose dependsOnTaskId is not "done" or "cancelled"
    // (A dependency on a task id that is not in the list counts as finished)
    const taskDeps = depsByTaskId.get(task.id);
    if (taskDeps) {
      let blocked = false;
      for (const depId of taskDeps) {
        const depTask = taskById.get(depId);
        if (depTask && depTask.status !== "done" && depTask.status !== "cancelled") {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        continue;
      }
    }

    // A parent is not eligible while any of its subtasks is not "done" or "cancelled"
    const subtasks = subtasksByParentId.get(task.id);
    if (subtasks) {
      let hasOpenSubtask = false;
      for (const sub of subtasks) {
        if (sub.status !== "done" && sub.status !== "cancelled") {
          hasOpenSubtask = true;
          break;
        }
      }
      if (hasOpenSubtask) {
        continue;
      }
    }

    result.push(task);
  }

  result.sort(compareCandidates);
  return result;
}

/**
 * Returns the first eligible task or null if none are eligible.
 */
export function pickNextTask(
  tasks: NextTaskCandidate[],
  deps: TaskDependencyEdge[],
  activeRunTaskIds: ReadonlySet<string>,
): NextTaskCandidate | null {
  const eligible = eligibleTasks(tasks, deps, activeRunTaskIds);
  return eligible.length > 0 ? eligible[0]! : null;
}

/**
 * Extracts the trimmed text of the first unchecked list item (- [ ] or * [ ])
 * under the specified markdown heading.
 */
export function firstUncheckedItem(markdown: string, heading: string): string | null {
  const targetHeading = heading.trim().toLowerCase();
  if (targetHeading === "") {
    return null;
  }

  const lines = markdown.split(/\r?\n/);
  let targetLevel: number | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);

    if (targetLevel === null) {
      if (headingMatch) {
        const level = headingMatch[1]!.length;
        const text = headingMatch[2]!.trim().toLowerCase();
        if (text === targetHeading) {
          targetLevel = level;
        }
      }
    } else {
      if (headingMatch) {
        const level = headingMatch[1]!.length;
        if (level <= targetLevel) {
          // Section ends at the next heading of the same or a higher level (fewer or equal '#')
          break;
        }
        // Deeper headings (level > targetLevel) stay in section
      }

      // Checked items are skipped
      if (/^\s*[-*]\s*\[[xX]\]/.test(line)) {
        continue;
      }

      // Unchecked item
      const uncheckedMatch = line.match(/^\s*[-*]\s*\[ \]\s*(.*)$/);
      if (uncheckedMatch) {
        return uncheckedMatch[1]!.trim();
      }
    }
  }

  return null;
}

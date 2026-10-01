/**
 * Structural validation and preview for Release 2D.3 templates
 * (docs/design/2D.3-reusable-templates.md §5, §7, §8). Pure and bounded:
 * every check is a single pass or an iterative Kahn topological sort — no
 * recursion whose depth depends on the input.
 */
import { addDays, isDateOnly, type DateOnly } from "@/core/calendar/dates";
import {
  MAX_CHECKLIST_ITEMS_PER_TASK,
  MAX_TOTAL_DOCUMENT_CONTENT,
} from "./limits";
import type { TemplateContent, TemplateIssue, TemplatePreview } from "./types";

/** Every cross-item rule. An empty list means the template can be applied. */
export function validateTemplate(content: TemplateContent): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const add = (path: string, message: string) => {
    if (issues.length < 100) issues.push({ path, message });
  };

  const milestoneKeys = new Set<string>();
  content.milestones.forEach((m, i) => {
    if (milestoneKeys.has(m.key)) add(`milestones[${i}].key`, `Duplicate milestone key "${m.key}".`);
    milestoneKeys.add(m.key);
  });

  const taskByKey = new Map<string, TemplateContent["tasks"][number]>();
  content.tasks.forEach((t, i) => {
    if (taskByKey.has(t.key)) add(`tasks[${i}].key`, `Duplicate task key "${t.key}".`);
    else taskByKey.set(t.key, t);
  });

  const hasChildren = new Set(content.tasks.flatMap((t) => (t.parentKey ? [t.parentKey] : [])));
  content.tasks.forEach((t, i) => {
    if (t.milestoneKey !== null && !milestoneKeys.has(t.milestoneKey)) {
      add(`tasks[${i}].milestoneKey`, `Unknown milestone "${t.milestoneKey}".`);
    }
    if (t.parentKey !== null) {
      const parent = taskByKey.get(t.parentKey);
      if (t.parentKey === t.key) add(`tasks[${i}].parentKey`, "A task cannot be its own parent.");
      else if (!parent) add(`tasks[${i}].parentKey`, `Unknown parent task "${t.parentKey}".`);
      else if (parent.parentKey !== null) add(`tasks[${i}].parentKey`, "Subtasks are one level deep: the parent must be a top-level task.");
      if (hasChildren.has(t.key)) add(`tasks[${i}].parentKey`, "A task with subtasks cannot itself be a subtask.");
    }
  });

  const edgeKeys = new Set<string>();
  content.dependencies.forEach((d, i) => {
    if (d.taskKey === d.dependsOnKey) add(`dependencies[${i}]`, "A task cannot depend on itself.");
    if (!taskByKey.has(d.taskKey)) add(`dependencies[${i}].taskKey`, `Unknown task "${d.taskKey}".`);
    if (!taskByKey.has(d.dependsOnKey)) add(`dependencies[${i}].dependsOnKey`, `Unknown task "${d.dependsOnKey}".`);
    const edge = `${d.taskKey}\u0000${d.dependsOnKey}`;
    if (edgeKeys.has(edge)) add(`dependencies[${i}]`, "Duplicate dependency.");
    edgeKeys.add(edge);
  });
  const cycle = findCycleMembers(content);
  if (cycle.length > 0) add("dependencies", `Dependencies form a cycle involving: ${cycle.slice(0, 10).join(", ")}.`);

  const perTask = new Map<string, number>();
  content.checklist.forEach((c, i) => {
    if (!taskByKey.has(c.taskKey)) add(`checklist[${i}].taskKey`, `Unknown task "${c.taskKey}".`);
    const n = (perTask.get(c.taskKey) ?? 0) + 1;
    perTask.set(c.taskKey, n);
    if (n === MAX_CHECKLIST_ITEMS_PER_TASK + 1) {
      add(`checklist[${i}]`, `A task may have at most ${MAX_CHECKLIST_ITEMS_PER_TASK} checklist items.`);
    }
  });

  const totalContent = content.documents.reduce((sum, d) => sum + d.content.length, 0);
  if (totalContent > MAX_TOTAL_DOCUMENT_CONTENT) {
    add("documents", `Documents may contain at most ${MAX_TOTAL_DOCUMENT_CONTENT.toLocaleString("en-US")} characters in total.`);
  }
  return issues;
}

/**
 * Tasks on or behind a dependency cycle, via Kahn's algorithm: repeatedly
 * remove tasks with no remaining dependencies; whatever cannot be removed is
 * in (or depends on) a cycle. Iterative, O(tasks + edges). Unknown endpoints
 * are ignored here (reported separately).
 */
export function findCycleMembers(content: Pick<TemplateContent, "tasks" | "dependencies">): string[] {
  const keys = new Set(content.tasks.map((t) => t.key));
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const k of keys) remaining.set(k, 0);
  const seen = new Set<string>();
  for (const d of content.dependencies) {
    if (!keys.has(d.taskKey) || !keys.has(d.dependsOnKey) || d.taskKey === d.dependsOnKey) continue;
    const edge = `${d.taskKey}\u0000${d.dependsOnKey}`;
    if (seen.has(edge)) continue;
    seen.add(edge);
    remaining.set(d.taskKey, remaining.get(d.taskKey)! + 1);
    if (!dependents.has(d.dependsOnKey)) dependents.set(d.dependsOnKey, []);
    dependents.get(d.dependsOnKey)!.push(d.taskKey);
  }
  const queue = [...keys].filter((k) => remaining.get(k) === 0);
  for (let head = 0; head < queue.length; head++) {
    for (const next of dependents.get(queue[head]!) ?? []) {
      const n = remaining.get(next)! - 1;
      remaining.set(next, n);
      if (n === 0) queue.push(next);
    }
  }
  return [...keys].filter((k) => remaining.get(k)! > 0).sort();
}

/** `start + offset` days, or null when the result leaves the supported calendar. */
export function relativeDate(start: DateOnly, offset: number): DateOnly | null {
  const date = addDays(start, offset);
  return isDateOnly(date) ? date : null;
}

/**
 * The server-computed preview of applying `content` at `startDate`. Never
 * writes. `errors` includes every structural issue plus any date that falls
 * outside the supported calendar; application refuses when it is non-empty.
 */
export function previewTemplate(
  templateId: string,
  content: TemplateContent,
  startDate: DateOnly,
  projectName?: string,
): TemplatePreview {
  const errors = validateTemplate(content);
  const dateOf = (offset: number | null, path: string): DateOnly | null => {
    if (offset === null) return null;
    const date = relativeDate(startDate, offset);
    if (date === null && errors.length < 100) {
      errors.push({ path, message: `Day ${offset} after ${startDate} is outside the supported calendar (1900-01-01 to 9999-12-31).` });
    }
    return date;
  };

  const dependsOn = new Map<string, string[]>();
  for (const d of content.dependencies) {
    if (!dependsOn.has(d.taskKey)) dependsOn.set(d.taskKey, []);
    dependsOn.get(d.taskKey)!.push(d.dependsOnKey);
  }
  const checklistCount = new Map<string, number>();
  for (const c of content.checklist) checklistCount.set(c.taskKey, (checklistCount.get(c.taskKey) ?? 0) + 1);

  const milestones = content.milestones.map((m, i) => ({
    key: m.key,
    title: m.title,
    targetDate: dateOf(m.targetOffset, `milestones[${i}].targetOffset`),
  }));
  const tasks = content.tasks.map((t, i) => ({
    key: t.key,
    title: t.title,
    priority: t.priority,
    dueDate: dateOf(t.dueOffset, `tasks[${i}].dueOffset`),
    milestoneKey: t.milestoneKey,
    parentKey: t.parentKey,
    dependsOn: dependsOn.get(t.key) ?? [],
    checklistCount: checklistCount.get(t.key) ?? 0,
  }));

  const warnings = ["Tasks are created unassigned: templates never copy assignees."];
  if (content.tasks.length > 0) warnings.push("Every task starts as To do; checklist items start incomplete.");

  const counts = {
    milestones: content.milestones.length,
    tasks: content.tasks.length,
    subtasks: content.tasks.filter((t) => t.parentKey !== null).length,
    dependencies: content.dependencies.length,
    checklist: content.checklist.length,
    documents: content.documents.length,
    records: 0,
  };
  // project + activity event + application record + every item.
  counts.records = 3 + counts.milestones + counts.tasks + counts.dependencies + counts.checklist + counts.documents;

  return {
    templateId,
    projectName: projectName ?? content.project.name,
    startDate,
    milestones,
    tasks,
    documents: content.documents.map((d) => ({ title: d.title, category: d.category, pinned: d.pinned, characters: d.content.length })),
    counts,
    errors,
    warnings,
  };
}

/** Release 2D.3 reusable templates — domain types. See docs/design/2D.3-reusable-templates.md. */
import type { DateOnly } from "@/core/calendar/dates";
import type { ProjectType } from "@/core/projects/types";
import type { TaskPriority } from "@/core/tasks/types";

/** Project statuses a template may set on the project it creates. */
export const TEMPLATE_PROJECT_STATUSES = ["idea", "planning", "active"] as const;
export type TemplateProjectStatus = (typeof TEMPLATE_PROJECT_STATUSES)[number];

/** A template-local identifier; never a database id. */
export const TEMPLATE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export interface TemplateMilestone {
  key: string;
  title: string;
  description: string | null;
  /** Days after the project start, or null for no target date. */
  targetOffset: number | null;
}

export interface TemplateTask {
  key: string;
  title: string;
  description: string | null;
  priority: TaskPriority;
  /** Days after the project start, or null for no due date. */
  dueOffset: number | null;
  milestoneKey: string | null;
  /** One level only: the parent must be a top-level task. */
  parentKey: string | null;
}

export interface TemplateDependency {
  /** `taskKey` cannot finish until `dependsOnKey` is done — the task_dependency direction. */
  taskKey: string;
  dependsOnKey: string;
}

export interface TemplateChecklistItem {
  taskKey: string;
  text: string;
}

export interface TemplateDocument {
  title: string;
  content: string;
  category: string | null;
  pinned: boolean;
}

/** The whole editable template. Array order is the stored order. */
export interface TemplateContent {
  name: string;
  description: string | null;
  project: {
    name: string;
    description: string | null;
    type: ProjectType;
    status: TemplateProjectStatus;
  };
  milestones: TemplateMilestone[];
  tasks: TemplateTask[];
  dependencies: TemplateDependency[];
  checklist: TemplateChecklistItem[];
  documents: TemplateDocument[];
}

export interface StoredTemplate extends TemplateContent {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateSummary {
  id: string;
  name: string;
  description: string | null;
  updatedAt: string;
  counts: { milestones: number; tasks: number; dependencies: number; checklist: number; documents: number };
}

export interface TemplateIssue {
  /** Dotted location, e.g. "tasks[3].parentKey". */
  path: string;
  message: string;
}

export interface TemplatePreview {
  templateId: string;
  projectName: string;
  startDate: DateOnly;
  milestones: { key: string; title: string; targetDate: DateOnly | null }[];
  tasks: {
    key: string;
    title: string;
    priority: TaskPriority;
    dueDate: DateOnly | null;
    milestoneKey: string | null;
    parentKey: string | null;
    dependsOn: string[];
    checklistCount: number;
  }[];
  documents: { title: string; category: string | null; pinned: boolean; characters: number }[];
  counts: {
    milestones: number;
    tasks: number;
    subtasks: number;
    dependencies: number;
    checklist: number;
    documents: number;
    /** Every row the application would create, including the project and its activity event. */
    records: number;
  };
  errors: TemplateIssue[];
  warnings: string[];
}

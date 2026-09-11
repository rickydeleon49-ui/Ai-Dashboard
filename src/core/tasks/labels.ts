/**
 * Presentation metadata for milestone/task enums — mirrors
 * `core/projects/labels.ts`'s own reasoning: kept beside the types so a new
 * status or priority is labelled and coloured everywhere the moment it's
 * added here.
 */
import type { MilestoneStatus, TaskPriority, TaskStatus } from "./types";

export interface EnumMeta {
  label: string;
  /** Tailwind classes for the badge. Uses the semantic tokens in globals.css. */
  className: string;
}

export const MILESTONE_STATUS_META: Record<MilestoneStatus, EnumMeta> = {
  open: { label: "Open", className: "text-sky-300 bg-sky-400/10 ring-sky-400/25" },
  completed: {
    label: "Completed",
    className: "text-emerald-300 bg-emerald-400/10 ring-emerald-400/25",
  },
  cancelled: { label: "Cancelled", className: "text-zinc-500 bg-zinc-500/10 ring-zinc-500/20" },
};

export const TASK_STATUS_META: Record<TaskStatus, EnumMeta> = {
  todo: { label: "To do", className: "text-zinc-400 bg-zinc-400/10 ring-zinc-400/20" },
  in_progress: { label: "In progress", className: "text-sky-300 bg-sky-400/10 ring-sky-400/25" },
  done: { label: "Done", className: "text-emerald-300 bg-emerald-400/10 ring-emerald-400/25" },
  cancelled: { label: "Cancelled", className: "text-zinc-500 bg-zinc-500/10 ring-zinc-500/20" },
};

export const TASK_PRIORITY_META: Record<TaskPriority, EnumMeta> = {
  low: { label: "Low", className: "text-zinc-400 bg-zinc-400/10 ring-zinc-400/20" },
  medium: { label: "Medium", className: "text-sky-300 bg-sky-400/10 ring-sky-400/25" },
  high: { label: "High", className: "text-amber-300 bg-amber-400/10 ring-amber-400/25" },
  urgent: { label: "Urgent", className: "text-red-300 bg-red-400/10 ring-red-400/25" },
};

/**
 * Presentation metadata for domain enums.
 *
 * Kept beside the types (rather than inside components) so that a new status or
 * source is labelled and coloured everywhere the moment it is added here.
 */
import type { ProjectSource, ProjectStatus, ProjectType } from "./types";

export interface EnumMeta {
  label: string;
  /** Tailwind classes for the badge. Uses the semantic tokens in globals.css. */
  className: string;
  description?: string;
}

export const STATUS_META: Record<ProjectStatus, EnumMeta> = {
  idea: {
    label: "Idea",
    className: "text-zinc-400 bg-zinc-400/10 ring-zinc-400/20",
    description: "Captured, not started",
  },
  planning: {
    label: "Planning",
    className: "text-sky-300 bg-sky-400/10 ring-sky-400/25",
    description: "Scoping and design",
  },
  active: {
    label: "Active",
    className: "text-emerald-300 bg-emerald-400/10 ring-emerald-400/25",
    description: "Currently being worked on",
  },
  paused: {
    label: "Paused",
    className: "text-amber-300 bg-amber-400/10 ring-amber-400/25",
    description: "On hold, will resume",
  },
  completed: {
    label: "Completed",
    className: "text-violet-300 bg-violet-400/10 ring-violet-400/25",
    description: "Shipped and done",
  },
  archived: {
    label: "Archived",
    className: "text-zinc-500 bg-zinc-500/10 ring-zinc-500/20",
    description: "Hidden from the default library view",
  },
};

export const SOURCE_META: Record<ProjectSource, EnumMeta> = {
  github: { label: "GitHub", className: "text-zinc-300 bg-white/5 ring-white/10" },
  uploaded: { label: "Uploaded", className: "text-zinc-300 bg-white/5 ring-white/10" },
  manual: { label: "Manual", className: "text-zinc-300 bg-white/5 ring-white/10" },
};

export const TYPE_META: Record<ProjectType, EnumMeta> = {
  software: { label: "Software", className: "" },
  website: { label: "Website", className: "" },
  ai: { label: "AI", className: "" },
  automation: { label: "Automation", className: "" },
  script: { label: "Script", className: "" },
  experiment: { label: "Experiment", className: "" },
  work: { label: "Work", className: "" },
  personal: { label: "Personal", className: "" },
  other: { label: "Other", className: "" },
};

/**
 * Colours for the language dot on GitHub cards.
 * Falls back to a neutral tone for anything unlisted.
 */
const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Python: "#3572A5",
  Rust: "#dea584",
  Go: "#00ADD8",
  Java: "#b07219",
  "C#": "#178600",
  "C++": "#f34b7d",
  C: "#555555",
  Ruby: "#701516",
  PHP: "#4F5D95",
  Swift: "#F05138",
  Kotlin: "#A97BFF",
  Shell: "#89e051",
  HTML: "#e34c26",
  CSS: "#563d7c",
  Lua: "#000080",
  Papyrus: "#6d4aff",
  Dockerfile: "#384d54",
  Vue: "#41b883",
  Svelte: "#ff3e00",
};

export function languageColor(language: string | null | undefined): string {
  if (!language) return "#6b7280";
  return LANGUAGE_COLORS[language] ?? "#6b7280";
}

/**
 * Quick actions surfaced on the dashboard and in the command palette.
 * Data-driven for the same reason navigation is: new actions are one entry.
 */
import type { LucideIcon } from "lucide-react";
import {
  FileUp,
  FolderPlus,
  Github,
  NotebookPen,
  Sparkles,
  Star,
} from "lucide-react";

export interface QuickAction {
  label: string;
  description: string;
  href: string;
  icon: LucideIcon;
  /** Actions from a later phase are shown, but marked and de-emphasised. */
  phase: number;
  shortcut?: string;
}

export const QUICK_ACTIONS: QuickAction[] = [
  {
    label: "New Project",
    description: "Add anything you are working on",
    href: "/projects/new",
    icon: FolderPlus,
    phase: 1,
    shortcut: "N",
  },
  {
    label: "Add GitHub Repository",
    description: "Sync and pin repositories",
    href: "/github",
    icon: Github,
    phase: 1,
    shortcut: "G",
  },
  {
    label: "Open Favorites",
    description: "Jump to pinned projects",
    href: "/favorites",
    icon: Star,
    phase: 1,
    shortcut: "F",
  },
  {
    label: "Upload Project",
    description: "Import a ZIP, folder or asset",
    href: "/uploads",
    icon: FileUp,
    phase: 1,
    shortcut: "U",
  },
  {
    label: "New AI Workspace",
    description: "Assistants, agents and workflows",
    href: "/ai",
    icon: Sparkles,
    phase: 4,
  },
  {
    label: "Add Note",
    description: "Capture a thought against a project",
    href: "/notes",
    icon: NotebookPen,
    phase: 3,
  },
];

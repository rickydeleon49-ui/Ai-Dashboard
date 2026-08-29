/**
 * Sidebar structure.
 *
 * The navigation is pure data. Adding a section to the dashboard means adding an
 * entry here and a route file — no component edits. `phase` marks routes whose
 * feature set arrives later; the UI renders them with a subdued "soon" marker
 * instead of pretending they are finished.
 */
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Boxes,
  FileUp,
  Github,
  LayoutDashboard,
  Library,
  type LucideIcon as Icon,
  NotebookPen,
  Plug,
  Settings,
  Sparkles,
  Star,
  Wrench,
  Workflow,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Shown as a small trailing count; resolved at render time. */
  countKey?: "total" | "github" | "uploaded" | "favorites" | "active";
  /** 1 = shipped now. Higher numbers render as upcoming. */
  phase: number;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAVIGATION: NavGroup[] = [
  {
    label: "Home",
    items: [
      { label: "Dashboard", href: "/", icon: LayoutDashboard, phase: 1 },
    ],
  },
  {
    label: "Projects",
    items: [
      { label: "All Projects", href: "/projects", icon: Library, countKey: "total", phase: 1 },
      { label: "GitHub", href: "/github", icon: Github, countKey: "github", phase: 1 },
      { label: "Uploaded", href: "/uploads", icon: FileUp, countKey: "uploaded", phase: 3 },
      { label: "Favorites", href: "/favorites", icon: Star, countKey: "favorites", phase: 1 },
    ],
  },
  {
    label: "AI",
    items: [
      { label: "AI Workspace", href: "/ai", icon: Sparkles, phase: 4 },
      { label: "Prompts", href: "/ai/prompts", icon: Bot, phase: 4 },
      { label: "Workflows", href: "/ai/workflows", icon: Workflow, phase: 4 },
    ],
  },
  {
    label: "Tools",
    items: [
      { label: "Tools", href: "/tools", icon: Wrench, phase: 5 },
      { label: "Integrations", href: "/integrations", icon: Plug, phase: 2 },
    ],
  },
  {
    label: "Other",
    items: [
      { label: "Notes", href: "/notes", icon: NotebookPen, phase: 3 },
      { label: "Settings", href: "/settings", icon: Settings, phase: 1 },
    ],
  },
];

export const APP_ICON: Icon = Boxes;
export const APP_NAME = "Command Center";

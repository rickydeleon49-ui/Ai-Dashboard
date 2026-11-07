/**
 * Sidebar structure.
 *
 * The navigation is pure data. Adding a section to the dashboard means adding an
 * entry here and a route file — no component edits.
 *
 * Only working features appear here. A sidebar full of entries that lead to a
 * description of what a page will one day do makes the whole application feel
 * unfinished, and it costs the user a click to find that out every time. Routes
 * for unbuilt sections still exist and are still reachable by URL — they are
 * just not advertised until they do something.
 *
 * `phase` is kept for the few entries whose feature set is genuinely partial, and
 * renders as a subdued marker. It is not a to-do list.
 */
import type { LucideIcon } from "lucide-react";
import {
  Bell,
  Bot,
  Boxes,
  CalendarDays,
  Cpu,
  FileUp,
  Github,
  LayoutDashboard,
  LayoutTemplate,
  Library,
  ListTodo,
  type LucideIcon as Icon,
  Plug,
  Settings,
  Sparkles,
  Star,
  Workflow,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Shown as a small trailing count; resolved at render time. */
  countKey?: "total" | "github" | "uploaded" | "favorites" | "active" | "prompts";
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
      { label: "My Work", href: "/my-work", icon: ListTodo, phase: 1 },
      { label: "Calendar", href: "/calendar", icon: CalendarDays, phase: 1 },
      { label: "Templates", href: "/templates", icon: LayoutTemplate, phase: 1 },
      { label: "GitHub", href: "/github", icon: Github, countKey: "github", phase: 1 },
      { label: "Uploaded", href: "/uploads", icon: FileUp, countKey: "uploaded", phase: 1 },
      { label: "Favorites", href: "/favorites", icon: Star, countKey: "favorites", phase: 1 },
    ],
  },
  {
    label: "AI",
    items: [
      { label: "Agents", href: "/agents", icon: Bot, phase: 1 },
      { label: "AI Workspace", href: "/ai", icon: Sparkles, phase: 1 },
      { label: "Local AI", href: "/ai/chat", icon: Cpu, phase: 1 },
      { label: "Prompts", href: "/ai/prompts", icon: Bot, countKey: "prompts", phase: 1 },
      { label: "Automations", href: "/ai/workflows", icon: Workflow, phase: 1 },
    ],
  },
  {
    label: "Tools",
    items: [
      { label: "Notifications", href: "/notifications", icon: Bell, phase: 1 },
      { label: "Integrations", href: "/integrations", icon: Plug, phase: 1 },
    ],
  },
  {
    label: "Other",
    items: [
      { label: "Settings", href: "/settings", icon: Settings, phase: 1 },
    ],
  },
];

export const ACCOUNTS_ALLOWED_PREFIXES = [
  "/",
  "/projects",
  "/my-work",
  "/calendar",
  "/templates",
  "/favorites",
  "/settings",
];

export function isItemAllowedInAccounts(href: string): boolean {
  return ACCOUNTS_ALLOWED_PREFIXES.some(
    (p) => href === p || (p !== "/" && href.startsWith(`${p}/`)),
  );
}

export function isNavItemVisible(
  item: NavItem,
  options: { accountsMode?: boolean; agentRunsEnabled?: boolean } = {},
): boolean {
  if (options.accountsMode && !isItemAllowedInAccounts(item.href)) {
    return false;
  }
  if (item.href === "/agents" || item.href.startsWith("/agents/")) {
    // Desktop-only; the server layout computes the flag and passes it down. Hidden unless told otherwise.
    return options.agentRunsEnabled === true;
  }
  return true;
}

export function getVisibleNavigation(
  options: { accountsMode?: boolean; agentRunsEnabled?: boolean } = {},
): NavGroup[] {
  return NAVIGATION.map((group) => ({
    ...group,
    items: group.items.filter((item) => isNavItemVisible(item, options)),
  })).filter((group) => group.items.length > 0);
}

export const APP_ICON: Icon = Boxes;
export const APP_NAME = "Command Center";

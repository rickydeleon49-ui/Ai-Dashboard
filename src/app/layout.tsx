import type { Metadata, Viewport } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { DesktopBridge } from "@/components/layout/desktop-bridge";
import { themeScript } from "@/components/layout/theme-script";
import { LOCAL_WORKSPACE_ID, projectRepository } from "@/db/repositories";
import { APP_NAME } from "@/config/navigation";
import { isAccountsMode } from "@/lib/auth-mode";
import { resolveWorkspaceIdForPage } from "@/core/workspaces/current-workspace";
import type { ProjectStats } from "@/core/projects/types";
import type { PaletteProject } from "@/components/layout/command-palette";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description:
    "A personal command center for projects, GitHub repositories, uploads and AI workflows.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#08090b" },
    { media: "(prefers-color-scheme: light)", color: "#fcfcfd" },
  ],
};

const EMPTY_STATS: ProjectStats = {
  total: 0,
  active: 0,
  github: 0,
  uploaded: 0,
  manual: 0,
  favorites: 0,
  archived: 0,
  completed: 0,
  prompts: 0,
  byStatus: {
    idea: 0,
    planning: 0,
    active: 0,
    paused: 0,
    completed: 0,
    archived: 0,
  },
};

// Sidebar counts and the palette index must reflect the latest writes.
export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const accountsMode = isAccountsMode();

  let stats: ProjectStats = EMPTY_STATS;
  let paletteProjects: PaletteProject[] = [];
  let unreadNotifications = 0;
  let inboxWorkspaceId: string | null = null;

  if (accountsMode) {
    // In accounts mode: resolve the signed-in user's active workspace before
    // displaying project statistics or palette data; do not query PostgreSQL using
    // the fixed local workspace ID; do not read shared SQLite notifications.
    const workspaceId = await resolveWorkspaceIdForPage();
    // The collaboration inbox button is keyed by this id, so switching
    // workspaces remounts it with no cached notifications (Release 2C.6).
    inboxWorkspaceId = workspaceId;
    if (workspaceId) {
      const [s, p] = await Promise.all([
        projectRepository.stats(workspaceId),
        projectRepository.listSummaries(workspaceId),
      ]);
      stats = s;
      paletteProjects = p;
    }
  } else {
    // In desktop or single-password mode: prepare SQLite and fetch local state.
    const { ensureDatabaseReady } = await import("@/db/bootstrap");
    const { unreadCount } = await import("@/core/automation/notifications");
    ensureDatabaseReady();

    const [s, p, u] = await Promise.all([
      projectRepository.stats(LOCAL_WORKSPACE_ID),
      projectRepository.listSummaries(LOCAL_WORKSPACE_ID),
      unreadCount(),
    ]);
    stats = s;
    paletteProjects = p;
    unreadNotifications = u;
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies the stored theme before paint to avoid a flash. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <DesktopBridge />
        <AppShell
          stats={stats}
          paletteProjects={paletteProjects}
          unreadNotifications={unreadNotifications}
          accountsMode={accountsMode}
          inboxWorkspaceId={inboxWorkspaceId}
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { DesktopBridge } from "@/components/layout/desktop-bridge";
import { themeScript } from "@/components/layout/theme-toggle";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { projectRepository } from "@/db/repositories";
import { APP_NAME } from "@/config/navigation";
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

// Sidebar counts and the palette index must reflect the latest writes.
export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Migrations run once per process, before the first query.
  ensureDatabaseReady();

  const [stats, projects] = await Promise.all([
    projectRepository.stats(),
    projectRepository.list({ includeArchived: true, limit: 300 }),
  ]);

  const paletteProjects = projects.map((project) => ({
    id: project.id,
    name: project.name,
    source: project.source,
    status: project.status,
  }));

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies the stored theme before paint to avoid a flash. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <DesktopBridge />
        <AppShell stats={stats} paletteProjects={paletteProjects}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}

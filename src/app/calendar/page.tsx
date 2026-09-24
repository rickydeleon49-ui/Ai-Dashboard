import { LogIn } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CalendarView } from "@/components/calendar/calendar-view";
import { resolveWorkspaceAndUserForPage } from "@/core/workspaces/current-workspace";
import { isAccountsMode } from "@/lib/auth-mode";

export const dynamic = "force-dynamic";
export const metadata = { title: "Calendar" };

/**
 * Release 2D.1 workspace calendar. Desktop reads SQLite; accounts mode reads
 * PostgreSQL for the caller's current workspace only. The view is keyed by the
 * workspace id, so switching workspaces remounts it with no cached items.
 * See docs/design/2D.1-calendar.md.
 */
export default async function CalendarPage() {
  const accountsMode = isAccountsMode();
  const resolved = await resolveWorkspaceAndUserForPage();
  if (!resolved) {
    return <EmptyState icon={LogIn} title="Sign-in required" description="Sign in to see the calendar." />;
  }

  let workspaces: { id: string; name: string }[] = [];
  if (accountsMode && resolved.userId) {
    const { listWorkspacesForUser } = await import("@/core/workspaces/service");
    workspaces = (await listWorkspacesForUser(resolved.userId, 50)).map((w) => ({ id: w.id, name: w.name }));
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Calendar"
        description="Task and milestone due dates. Drag an item to a new day, or use Reschedule, then Save."
      />
      <CalendarView
        key={resolved.workspaceId}
        workspaceId={resolved.workspaceId}
        accountsMode={accountsMode}
        workspaces={workspaces}
      />
    </div>
  );
}

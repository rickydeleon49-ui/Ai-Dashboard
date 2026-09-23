import { notFound } from "next/navigation";
import { LogIn } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { InboxView } from "@/components/notifications/inbox-view";
import { resolveWorkspaceIdForPage } from "@/core/workspaces/current-workspace";
import { isAccountsMode } from "@/lib/auth-mode";

export const dynamic = "force-dynamic";
export const metadata = { title: "Inbox" };

/**
 * Release 2C.6 collaboration inbox. Accounts mode only: desktop deliberately
 * has no collaboration notifications (docs/design/2C.6-collaboration-notifications.md §9),
 * and its automation inbox stays at /notifications.
 */
export default async function InboxPage() {
  if (!isAccountsMode()) notFound();

  const workspaceId = await resolveWorkspaceIdForPage();
  if (!workspaceId) {
    return <EmptyState icon={LogIn} title="Sign-in required" description="Sign in to see your notifications." />;
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Inbox"
        description="Assignments, mentions, comments and due-date changes for you in this workspace."
      />
      <InboxView key={workspaceId} workspaceId={workspaceId} />
    </div>
  );
}

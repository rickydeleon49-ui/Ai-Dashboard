import { Bell } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { NotificationList } from "@/components/automation/notification-list";
import { listNotifications } from "@/core/automation/notifications";

export const dynamic = "force-dynamic";
export const metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const notifications = await listNotifications();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Notifications"
        description="What your automations found while you were away."
      />

      {notifications.length === 0 ? (
        <EmptyState
          icon={Bell}
          title="Nothing to report"
          description="Automations post here when they find something worth your attention — a stalled project, new repositories, or a run that failed."
        />
      ) : (
        <NotificationList notifications={notifications} />
      )}
    </div>
  );
}

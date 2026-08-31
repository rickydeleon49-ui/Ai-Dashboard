import Link from "next/link";
import { Info } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardBody } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { AutomationRow } from "@/components/automation/automation-row";
import { listAutomations } from "@/core/automation/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Automations" };

export default async function AutomationsPage() {
  const automations = await listAutomations();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Automations"
        description="Work the dashboard does for you, on a schedule."
        actions={
          <Link href="/notifications" className={buttonClasses("secondary", "md")}>
            Notifications
          </Link>
        }
      />

      <Card>
        <CardBody className="flex items-start gap-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-faint" strokeWidth={1.75} />
          <p className="text-[12.5px] leading-relaxed text-muted">
            These run while Command Center is open, and anything that fell due
            while it was closed runs shortly after you reopen it. There is no
            background service — a desktop app is not running when you are not
            using it, and pretending otherwise would mean promising updates that
            never arrive.
          </p>
        </CardBody>
      </Card>

      <div className="space-y-3">
        {automations.map((automation) => (
          <AutomationRow key={automation.id} automation={automation} />
        ))}
      </div>
    </div>
  );
}

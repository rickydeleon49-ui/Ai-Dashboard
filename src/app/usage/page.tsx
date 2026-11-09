import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { UsageView } from "@/components/usage/usage-view";
import { isAgentRunsEnabled } from "@/core/agents/availability";

export const dynamic = "force-dynamic";
export const metadata = { title: "Usage" };

export default function UsagePage() {
  // Desktop only, same guard as the agent pages.
  if (!isAgentRunsEnabled()) notFound();

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        title="Usage"
        description="How much of each AI you are using, from the tracker files."
      />
      <UsageView />
    </div>
  );
}

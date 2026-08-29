import { Workflow } from "lucide-react";
import { PhasePage } from "@/components/ui/phase-page";

export const metadata = { title: "Workflows" };

export default function WorkflowsPage() {
  return (
    <PhasePage
      icon={Workflow}
      title="AI Workflows"
      phase={4}
      description="Multi-step AI routines you can run against a project on demand or on a schedule."
      foundation="The activity feed and project model give workflows somewhere to write results; scheduling arrives with Phase 5 automation."
      features={[
        { title: "Workflow builder", detail: "Chain prompts, tools and integrations." },
        { title: "Scheduled runs", detail: "Nightly summaries, weekly digests, repo checks." },
        { title: "Run history", detail: "Every execution recorded in the activity feed." },
        { title: "Project triggers", detail: "Fire on a status change or a new commit." },
      ]}
    />
  );
}

import { Workflow } from "lucide-react";
import { PhasePage } from "@/components/ui/phase-page";

export const metadata = { title: "Workflows" };

export default function WorkflowsPage() {
  return (
    <PhasePage
      icon={Workflow}
      title="AI Workflows"
      phase={5}
      description="Multi-step AI routines you can run against a project, on demand or on a schedule."
      foundation="Waiting on the automation layer rather than the UI. A workflow that cannot be executed is only a list, and the thing that executes it — a scheduler, a run history, somewhere for results to land — is Phase 5. The prompt library it will compose is already here, and the activity feed already gives runs somewhere to be recorded."
      features={[
        {
          title: "Compose from prompts",
          detail: "Chain saved prompts into a routine instead of retyping them.",
        },
        {
          title: "Scheduled runs",
          detail: "Nightly summaries, weekly digests, repository checks.",
        },
        { title: "Run history", detail: "Every execution recorded in the activity feed." },
        {
          title: "Project triggers",
          detail: "Fire on a status change or a new commit.",
        },
      ]}
      action={{ label: "Browse the prompt library", href: "/ai/prompts" }}
    />
  );
}

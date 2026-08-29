import { Wrench } from "lucide-react";
import { PhasePage } from "@/components/ui/phase-page";

export const metadata = { title: "Tools" };

export default function ToolsPage() {
  return (
    <PhasePage
      icon={Wrench}
      title="Tools"
      phase={5}
      description="Utilities and shortcuts you reach for constantly, kept next to the projects they serve."
      foundation="The quick-actions registry (src/config/quick-actions.ts) is already data-driven, so a tool becomes a single config entry plus its route."
      features={[
        { title: "Custom launchers", detail: "Open a local path, script or URL in one click." },
        { title: "Scheduled tasks", detail: "Recurring jobs with run history." },
        { title: "Project monitoring", detail: "Watch repos, deployments and uptime." },
        { title: "Notifications", detail: "Surface what changed since you last looked." },
      ]}
    />
  );
}

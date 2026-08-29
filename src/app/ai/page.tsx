import { Sparkles } from "lucide-react";
import { PhasePage } from "@/components/ui/phase-page";

export const metadata = { title: "AI Workspace" };

export default function AiWorkspacePage() {
  return (
    <PhasePage
      icon={Sparkles}
      title="AI Workspace"
      phase={4}
      description="Assistants, coding agents and AI experiments, organised the same way your projects are."
      foundation="AI routes and navigation exist, and the project model already supports an 'ai' project type so AI work can live in the library today."
      features={[
        {
          title: "AI assistants",
          detail: "Named assistants with their own instructions and context.",
        },
        {
          title: "Claude & ChatGPT projects",
          detail: "Link external AI projects and jump straight into them.",
        },
        {
          title: "Coding agents",
          detail: "Register agents and point them at a project in the library.",
        },
        {
          title: "AI experiments",
          detail: "Track what you tried, what worked, and what it cost.",
        },
        {
          title: "Generated documentation",
          detail: "Let an assistant write and refresh a project's docs.",
        },
        {
          title: "Automation tools",
          detail: "Reusable AI actions you can run against any project.",
        },
      ]}
      action={{ label: "Track an AI project now", href: "/projects/new" }}
    />
  );
}

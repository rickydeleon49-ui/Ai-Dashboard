import { PageHeader } from "@/components/ui/page-header";
import { ProjectForm } from "@/components/projects/project-form";

export const metadata = { title: "New Project" };

export default function NewProjectPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="New project"
        description="Anything you work on: software, websites, AI experiments, scripts, automations or notes-to-self."
      />
      <ProjectForm />
    </div>
  );
}

import { PageHeader } from "@/components/ui/page-header";
import { PromptForm } from "@/components/prompts/prompt-form";

export const metadata = { title: "New Prompt" };

export default function NewPromptPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="New prompt"
        description="Anything you would otherwise rewrite from memory."
      />
      <PromptForm />
    </div>
  );
}

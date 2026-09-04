import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { PromptForm } from "@/components/prompts/prompt-form";
import { findPrompt } from "@/core/prompts/service";

export const dynamic = "force-dynamic";

export default async function EditPromptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const prompt = await findPrompt((await params).id);
  if (!prompt) notFound();

  return (
    <div className="space-y-5">
      <PageHeader title={`Edit ${prompt.title}`} />
      <PromptForm prompt={prompt} />
    </div>
  );
}

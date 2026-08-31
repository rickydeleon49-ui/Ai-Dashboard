import Link from "next/link";
import { Bot } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { PromptCard } from "@/components/prompts/prompt-card";
import { PromptFilters } from "@/components/prompts/prompt-filters";
import { listPrompts, promptCategories } from "@/core/prompts/service";
import type { SearchParams } from "@/lib/routing";

export const dynamic = "force-dynamic";
export const metadata = { title: "Prompts" };

export default async function PromptsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const raw = await searchParams;
  const first = (key: string) => {
    const value = raw[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const [prompts, categories] = await Promise.all([
    listPrompts({
      search: first("search"),
      category: first("category"),
      favorite: first("favorite") === "1",
    }),
    promptCategories(),
  ]);

  const filtered = Boolean(first("search") || first("category") || first("favorite"));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Prompt Library"
        description="The prompts you keep rewriting, kept somewhere findable."
        actions={
          <Link href="/ai/prompts/new" className={buttonClasses("primary", "md")}>
            New prompt
          </Link>
        }
      />

      <PromptFilters categories={categories} />

      {prompts.length === 0 ? (
        <EmptyState
          icon={Bot}
          title={filtered ? "No prompts match" : "No prompts yet"}
          description={
            filtered
              ? "Try a different search, or clear the filters."
              : "Save a prompt once and it is one click away from anywhere you work."
          }
          action={
            filtered ? (
              <Link href="/ai/prompts" className={buttonClasses("secondary", "lg")}>
                Clear filters
              </Link>
            ) : (
              <Link href="/ai/prompts/new" className={buttonClasses("primary", "lg")}>
                New prompt
              </Link>
            )
          }
        />
      ) : (
        <>
          <p className="text-[12px] text-faint">
            {prompts.length} {prompts.length === 1 ? "prompt" : "prompts"}
          </p>
          <div className="grid gap-3 lg:grid-cols-2">
            {prompts.map((prompt) => (
              <PromptCard key={prompt.id} prompt={prompt} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

import Link from "next/link";
import { Bot, ExternalLink, Sparkles, Workflow } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ProjectGrid } from "@/components/projects/project-card";
import { PromptCard } from "@/components/prompts/prompt-card";
import { projectRepository } from "@/db/repositories";
import { listPrompts } from "@/core/prompts/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI Workspace" };

/**
 * External tools worth one click. Deliberately plain links rather than
 * integrations: opening the thing you already use is most of the value, and
 * pretending to wrap it would be worse than a shortcut.
 */
const AI_TOOLS = [
  { name: "Claude", href: "https://claude.ai", detail: "Projects and conversations" },
  { name: "Claude Code", href: "https://claude.ai/code", detail: "Agentic coding" },
  { name: "ChatGPT", href: "https://chatgpt.com", detail: "Projects and GPTs" },
  { name: "Anthropic Console", href: "https://console.anthropic.com", detail: "API keys and usage" },
];

export default async function AiWorkspacePage() {
  const [aiProjects, recentPrompts, allPrompts] = await Promise.all([
    projectRepository.list({ type: "ai", sort: "updated" }),
    listPrompts({ favorite: true }),
    listPrompts(),
  ]);

  // Favourites lead; if there are none, the most recent still gives the page
  // something useful to show rather than an empty panel.
  const prompts = (recentPrompts.length > 0 ? recentPrompts : allPrompts).slice(0, 4);

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI Workspace"
        description="Your AI projects, prompts and tools in one place."
        actions={
          <Link href="/ai/prompts/new" className={buttonClasses("primary", "md")}>
            New prompt
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Link
          href="/ai/prompts"
          className="rounded-xl border border-line bg-surface p-3.5 transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-subtle)]"
        >
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] font-medium text-muted">Prompts</span>
            <Bot className="h-3.5 w-3.5 text-faint" strokeWidth={1.75} />
          </div>
          <p className="mt-1.5 text-2xl font-semibold tabular-nums text-fg">
            {allPrompts.length}
          </p>
        </Link>

        <Link
          href="/projects?type=ai"
          className="rounded-xl border border-line bg-surface p-3.5 transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-subtle)]"
        >
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] font-medium text-muted">AI projects</span>
            <Sparkles className="h-3.5 w-3.5 text-faint" strokeWidth={1.75} />
          </div>
          <p className="mt-1.5 text-2xl font-semibold tabular-nums text-fg">
            {aiProjects.length}
          </p>
        </Link>

        <Link
          href="/ai/workflows"
          className="rounded-xl border border-line bg-surface p-3.5 opacity-65 transition-colors hover:border-[var(--border-strong)]"
        >
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] font-medium text-muted">Workflows</span>
            <Workflow className="h-3.5 w-3.5 text-faint" strokeWidth={1.75} />
          </div>
          <p className="mt-1.5 text-[11px] text-faint">Needs the Phase 5 runner</p>
        </Link>

        <div className="rounded-xl border border-line bg-surface p-3.5">
          <span className="text-[11.5px] font-medium text-muted">Favorites</span>
          <p className="mt-1.5 text-2xl font-semibold tabular-nums text-fg">
            {allPrompts.filter((p) => p.favorite).length}
          </p>
        </div>
      </div>

      <section className="space-y-2.5">
        <h2 className="text-[13px] font-semibold tracking-tight text-fg">Tools</h2>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {AI_TOOLS.map((tool) => (
            <a
              key={tool.name}
              href={tool.href}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2.5 transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-subtle)]"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-fg">
                  {tool.name}
                </span>
                <span className="block truncate text-[11.5px] text-faint">
                  {tool.detail}
                </span>
              </span>
              <ExternalLink
                className="h-3.5 w-3.5 shrink-0 text-faint transition-colors group-hover:text-muted"
                strokeWidth={1.75}
              />
            </a>
          ))}
        </div>
      </section>

      <section className="space-y-2.5">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold tracking-tight text-fg">
            {recentPrompts.length > 0 ? "Pinned prompts" : "Recent prompts"}
          </h2>
          <Link
            href="/ai/prompts"
            className="text-[12px] text-muted transition-colors hover:text-fg"
          >
            View all
          </Link>
        </div>

        {prompts.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="No prompts yet"
            description="Save a prompt once and it is one click away from anywhere you work."
            action={
              <Link href="/ai/prompts/new" className={buttonClasses("primary", "lg")}>
                New prompt
              </Link>
            }
          />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {prompts.map((prompt) => (
              <PromptCard key={prompt.id} prompt={prompt} />
            ))}
          </div>
        )}
      </section>

      {aiProjects.length > 0 ? (
        <section className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold tracking-tight text-fg">
              AI projects
            </h2>
            <Link
              href="/projects?type=ai"
              className="text-[12px] text-muted transition-colors hover:text-fg"
            >
              View all
            </Link>
          </div>
          <ProjectGrid projects={aiProjects} />
        </section>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>AI projects</CardTitle>
          </CardHeader>
          <CardBody>
            <p className="text-[13px] leading-relaxed text-muted">
              Any project with the type <strong className="text-fg">AI</strong> appears
              here — assistants, agents, experiments, or a link to a Claude or ChatGPT
              project. Set the type when creating or editing a project.
            </p>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

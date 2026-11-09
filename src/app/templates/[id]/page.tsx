import Link from "next/link";
import { LogIn } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { TemplateEditor } from "@/components/templates/template-editor";
import { resolveWorkspaceAndUserForPage } from "@/core/workspaces/current-workspace";

export const dynamic = "force-dynamic";
export const metadata = { title: "Template" };

/**
 * One template: edit it (members), preview it for a start date, and create a
 * project from it. Keyed by workspace and template; the API authorizes.
 */
export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const resolved = await resolveWorkspaceAndUserForPage();
  if (!resolved) {
    return <EmptyState icon={LogIn} title="Sign-in required" description="Sign in to see this template." />;
  }
  return (
    <div className="min-w-0 space-y-5">
      <nav className="flex flex-wrap items-center gap-1.5 text-[12px] text-faint min-w-0" aria-label="Breadcrumb">
        <Link href="/templates" className="transition-colors hover:text-fg">
          Templates
        </Link>
        <span>/</span>
        <span className="text-muted">Template</span>
      </nav>
      <TemplateEditor key={`${resolved.workspaceId}:${id}`} templateId={id} />
    </div>
  );
}

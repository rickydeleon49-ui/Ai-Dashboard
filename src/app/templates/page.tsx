import { LogIn } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { TemplateList } from "@/components/templates/template-list";
import { resolveWorkspaceAndUserForPage } from "@/core/workspaces/current-workspace";

export const dynamic = "force-dynamic";
export const metadata = { title: "Templates" };

/**
 * Release 2D.3 reusable templates (docs/design/2D.3-reusable-templates.md).
 * Desktop: SQLite, no account. Accounts mode: the current workspace's
 * templates; the API re-authorizes every request. Keyed by workspace.
 */
export default async function TemplatesPage() {
  const resolved = await resolveWorkspaceAndUserForPage();
  if (!resolved) {
    return <EmptyState icon={LogIn} title="Sign-in required" description="Sign in to see templates." />;
  }
  return (
    <div className="space-y-5">
      <PageHeader
        title="Templates"
        description="Reusable project structures. Preview a template for a start date, then create a real project from it."
      />
      <TemplateList key={resolved.workspaceId} />
    </div>
  );
}

import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { PageHeader } from "@/components/ui/page-header";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import { getPolicy, type ProjectPolicy } from "@/core/agents/policy";
import { db } from "@/db/client";
import { projects } from "@/db/schema";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { ProjectPolicyEditor } from "@/components/agents/settings/project-policy-editor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Project Policy" };

interface ProjectPolicyPageProps {
  params: Promise<{ id: string }>;
}

export default async function ProjectPolicyPage({
  params,
}: ProjectPolicyPageProps) {
  if (!isAgentRunsEnabled()) {
    notFound();
  }

  const { id } = await params;

  await ensureDatabaseReady();

  const project = db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.id, id))
    .get();

  if (!project) {
    notFound();
  }

  let initialPolicy: ProjectPolicy | null = null;
  let loadError: string | null = null;

  try {
    initialPolicy = await getPolicy(db, id);
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Project policy"
        description={`${project.name}: checks the runner runs, paths agents may not change, and shared folders.`}
      />
      <ProjectPolicyEditor
        projectId={id}
        initialPolicy={initialPolicy}
        loadError={loadError}
      />
    </div>
  );
}

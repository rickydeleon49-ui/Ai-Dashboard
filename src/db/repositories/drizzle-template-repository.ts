/**
 * SQLite TemplateRepository (Release 2D.3), desktop only. Single-tenant: it
 * asserts `LOCAL_WORKSPACE_ID` and stores no user ids. Every write runs in one
 * synchronous better-sqlite3 transaction, so nothing can interleave and a
 * failure leaves no partial project. See docs/design/2D.3-reusable-templates.md.
 */
import { asc, count, eq, and, sql } from "drizzle-orm";
import { db } from "../client";
import {
  activityEvents,
  knowledgeDocuments,
  milestones,
  projectTemplateApplications,
  projectTemplateChecklistItems,
  projectTemplateDependencies,
  projectTemplateDocuments,
  projectTemplateMilestones,
  projectTemplates,
  projectTemplateTasks,
  projects,
  taskChecklistItems,
  taskDependencies,
  tasks,
} from "../schema";
import { buildKnowledgeSearchText } from "@/core/knowledge/markdown";
import { createId } from "@/lib/ids";
import { MAX_TEMPLATES_PER_WORKSPACE } from "@/core/templates/limits";
import { previewTemplate } from "@/core/templates/validate";
import type { StoredTemplate, TemplateContent, TemplateSummary } from "@/core/templates/types";
import type { ProjectType } from "@/core/projects/types";
import type { TaskPriority } from "@/core/tasks/types";
import { LOCAL_WORKSPACE_ID } from "./project-repository";
import {
  InjectedApplyFailure,
  type ApplyActor,
  type ApplyFailurePoint,
  type ApplyRequest,
  type ApplyResult,
  type CreateResult,
  type TemplateRepository,
} from "./template-repository";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

function assertLocalWorkspace(workspaceId: string): void {
  if (workspaceId !== LOCAL_WORKSPACE_ID) {
    throw new Error(
      `DrizzleTemplateRepository (SQLite) only serves "${LOCAL_WORKSPACE_ID}"; got "${workspaceId}". ` +
        "Hosted multi-user mode must use PostgresTemplateRepository instead.",
    );
  }
}

class ApplyAbort extends Error {
  constructor(readonly result: ApplyResult) {
    super("apply aborted");
  }
}

function isIdempotencyConflict(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return (
    !!e &&
    e.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    typeof e.message === "string" &&
    e.message.includes("project_template_applications.idempotency_key")
  );
}

function readTemplate(dbx: Executor, id: string): StoredTemplate | null {
  const t = dbx.select().from(projectTemplates).where(eq(projectTemplates.id, id)).get();
  if (!t) return null;
  const ms = dbx.select().from(projectTemplateMilestones).where(eq(projectTemplateMilestones.templateId, id)).orderBy(asc(projectTemplateMilestones.position)).all();
  const ts = dbx.select().from(projectTemplateTasks).where(eq(projectTemplateTasks.templateId, id)).orderBy(asc(projectTemplateTasks.position)).all();
  const ds = dbx
    .select()
    .from(projectTemplateDependencies)
    .where(eq(projectTemplateDependencies.templateId, id))
    .orderBy(asc(projectTemplateDependencies.taskKey), asc(projectTemplateDependencies.dependsOnKey))
    .all();
  const cs = dbx
    .select()
    .from(projectTemplateChecklistItems)
    .where(eq(projectTemplateChecklistItems.templateId, id))
    .orderBy(asc(projectTemplateChecklistItems.taskKey), asc(projectTemplateChecklistItems.position))
    .all();
  const docs = dbx.select().from(projectTemplateDocuments).where(eq(projectTemplateDocuments.templateId, id)).orderBy(asc(projectTemplateDocuments.position)).all();

  const taskOrder = new Map(ts.map((row, i) => [row.key, i]));
  cs.sort((a, b) => (taskOrder.get(a.taskKey) ?? 0) - (taskOrder.get(b.taskKey) ?? 0) || a.position - b.position);

  return {
    id: t.id,
    name: t.name,
    description: t.description,
    project: {
      name: t.projectName,
      description: t.projectDescription,
      type: t.projectType as ProjectType,
      status: t.projectStatus as StoredTemplate["project"]["status"],
    },
    milestones: ms.map((m) => ({ key: m.key, title: m.title, description: m.description, targetOffset: m.targetOffset })),
    tasks: ts.map((row) => ({
      key: row.key,
      title: row.title,
      description: row.description,
      priority: row.priority as TaskPriority,
      dueOffset: row.dueOffset,
      milestoneKey: row.milestoneKey,
      parentKey: row.parentKey,
    })),
    dependencies: ds.map((d) => ({ taskKey: d.taskKey, dependsOnKey: d.dependsOnKey })),
    checklist: cs.map((c) => ({ taskKey: c.taskKey, text: c.text })),
    documents: docs.map((d) => ({ title: d.title, content: d.content, category: d.category, pinned: d.pinned })),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

function insertChildren(tx: Tx, id: string, content: TemplateContent): void {
  if (content.milestones.length > 0) {
    tx.insert(projectTemplateMilestones)
      .values(
        content.milestones.map((m, i) => ({
          id: createId("tpm"),
          templateId: id,
          key: m.key,
          position: i,
          title: m.title,
          description: m.description,
          targetOffset: m.targetOffset,
        })),
      )
      .run();
  }
  const taskRow = (t: TemplateContent["tasks"][number]) => ({
    id: createId("tpt"),
    templateId: id,
    key: t.key,
    position: content.tasks.indexOf(t),
    title: t.title,
    description: t.description,
    priority: t.priority,
    dueOffset: t.dueOffset,
    milestoneKey: t.milestoneKey,
    parentKey: t.parentKey,
  });
  const topLevel = content.tasks.filter((t) => t.parentKey === null);
  const subtasks = content.tasks.filter((t) => t.parentKey !== null);
  // SQLite caps bound parameters per statement; 300 tasks × 10 columns fits, chunks keep it safe.
  for (const group of [topLevel, subtasks]) {
    for (let i = 0; i < group.length; i += 100) tx.insert(projectTemplateTasks).values(group.slice(i, i + 100).map(taskRow)).run();
  }
  for (let i = 0; i < content.dependencies.length; i += 200) {
    tx.insert(projectTemplateDependencies)
      .values(content.dependencies.slice(i, i + 200).map((d) => ({ templateId: id, taskKey: d.taskKey, dependsOnKey: d.dependsOnKey })))
      .run();
  }
  const positions = new Map<string, number>();
  const checklistRows = content.checklist.map((c) => {
    const position = positions.get(c.taskKey) ?? 0;
    positions.set(c.taskKey, position + 1);
    return { id: createId("tpc"), templateId: id, taskKey: c.taskKey, position, text: c.text };
  });
  for (let i = 0; i < checklistRows.length; i += 200) tx.insert(projectTemplateChecklistItems).values(checklistRows.slice(i, i + 200)).run();
  if (content.documents.length > 0) {
    tx.insert(projectTemplateDocuments)
      .values(
        content.documents.map((d, i) => ({
          id: createId("tpd"),
          templateId: id,
          position: i,
          title: d.title,
          content: d.content,
          category: d.category,
          pinned: d.pinned,
        })),
      )
      .run();
  }
}

function deleteChildren(tx: Tx, id: string): void {
  for (const table of [projectTemplateDependencies, projectTemplateChecklistItems, projectTemplateTasks, projectTemplateMilestones, projectTemplateDocuments]) {
    tx.delete(table).where(eq(table.templateId, id)).run();
  }
}

export class DrizzleTemplateRepository implements TemplateRepository {
  async list(workspaceId: string): Promise<TemplateSummary[]> {
    assertLocalWorkspace(workspaceId);
    const rows = db
      .select({ id: projectTemplates.id, name: projectTemplates.name, description: projectTemplates.description, updatedAt: projectTemplates.updatedAt })
      .from(projectTemplates)
      .orderBy(asc(projectTemplates.name), asc(projectTemplates.id))
      .limit(MAX_TEMPLATES_PER_WORKSPACE)
      .all();
    const counts = db.all<TemplateSummary["counts"] & { id: string }>(sql`
      SELECT t.id,
        (SELECT count(*) FROM project_template_milestones x WHERE x.template_id = t.id) AS milestones,
        (SELECT count(*) FROM project_template_tasks x WHERE x.template_id = t.id) AS tasks,
        (SELECT count(*) FROM project_template_dependencies x WHERE x.template_id = t.id) AS dependencies,
        (SELECT count(*) FROM project_template_checklist_items x WHERE x.template_id = t.id) AS checklist,
        (SELECT count(*) FROM project_template_documents x WHERE x.template_id = t.id) AS documents
      FROM project_templates t
    `);
    const byId = new Map(counts.map((r) => [r.id, r]));
    return rows.map((r) => {
      const c = byId.get(r.id);
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        updatedAt: r.updatedAt,
        counts: {
          milestones: c?.milestones ?? 0,
          tasks: c?.tasks ?? 0,
          dependencies: c?.dependencies ?? 0,
          checklist: c?.checklist ?? 0,
          documents: c?.documents ?? 0,
        },
      };
    });
  }

  async get(workspaceId: string, id: string): Promise<StoredTemplate | null> {
    assertLocalWorkspace(workspaceId);
    return readTemplate(db, id);
  }

  async create(workspaceId: string, content: TemplateContent): Promise<CreateResult> {
    assertLocalWorkspace(workspaceId);
    return db.transaction((tx) => {
      const [{ n }] = tx.select({ n: count() }).from(projectTemplates).all() as [{ n: number }];
      if (n >= MAX_TEMPLATES_PER_WORKSPACE) return { kind: "limit_reached" as const };
      const id = createId("tpl");
      tx.insert(projectTemplates)
        .values({
          id,
          name: content.name,
          description: content.description,
          projectName: content.project.name,
          projectDescription: content.project.description,
          projectType: content.project.type,
          projectStatus: content.project.status,
        })
        .run();
      insertChildren(tx, id, content);
      return { kind: "created" as const, id };
    });
  }

  async replace(workspaceId: string, id: string, content: TemplateContent): Promise<boolean> {
    assertLocalWorkspace(workspaceId);
    return db.transaction((tx) => {
      const existing = tx.select({ id: projectTemplates.id }).from(projectTemplates).where(eq(projectTemplates.id, id)).get();
      if (!existing) return false;
      deleteChildren(tx, id);
      tx.update(projectTemplates)
        .set({
          name: content.name,
          description: content.description,
          projectName: content.project.name,
          projectDescription: content.project.description,
          projectType: content.project.type,
          projectStatus: content.project.status,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(projectTemplates.id, id))
        .run();
      insertChildren(tx, id, content);
      return true;
    });
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    assertLocalWorkspace(workspaceId);
    return db.delete(projectTemplates).where(eq(projectTemplates.id, id)).returning({ id: projectTemplates.id }).all().length > 0;
  }

  async apply(
    workspaceId: string,
    templateId: string,
    request: ApplyRequest,
    actor: ApplyActor,
    testFailAfter?: ApplyFailurePoint,
  ): Promise<ApplyResult> {
    assertLocalWorkspace(workspaceId);
    const failAfter = (point: ApplyFailurePoint) => {
      if (testFailAfter === point) throw new InjectedApplyFailure(point);
    };
    // A key that already created a project answers from its record, even if
    // the template has since been deleted (design note §13).
    const prior = this.replay(request, actor);
    if (prior) return prior;
    try {
      return db.transaction((tx) => {
        const template = tx
          .select({ id: projectTemplates.id, name: projectTemplates.name })
          .from(projectTemplates)
          .where(eq(projectTemplates.id, templateId))
          .get();
        if (!template) throw new ApplyAbort({ kind: "not_found" });

        const applicationId = createId("tap");
        tx.insert(projectTemplateApplications)
          .values({
            id: applicationId,
            actorKey: actor.actorKey,
            idempotencyKey: request.idempotencyKey,
            requestHash: request.requestHash,
            templateId,
            projectId: null,
          })
          .run();
        failAfter("application");

        const content = readTemplate(tx, templateId)!;
        const preview = previewTemplate(templateId, content, request.startDate, request.name);
        if (preview.errors.length > 0) throw new ApplyAbort({ kind: "invalid", issues: preview.errors });

        const now = new Date().toISOString();
        const projectId = createId("prj");
        const projectName = preview.projectName;
        tx.insert(projects)
          .values({
            id: projectId,
            name: projectName,
            description: content.project.description,
            source: "manual",
            type: content.project.type,
            status: content.project.status,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        failAfter("project");

        const milestoneIds: Record<string, string> = {};
        if (content.milestones.length > 0) {
          tx.insert(milestones)
            .values(
              preview.milestones.map((m, i) => {
                milestoneIds[m.key] = createId("mst");
                return {
                  id: milestoneIds[m.key]!,
                  projectId,
                  title: m.title,
                  description: content.milestones[i]!.description,
                  status: "open",
                  dueDate: m.targetDate,
                  createdAt: now,
                  updatedAt: now,
                };
              }),
            )
            .run();
        }
        failAfter("milestones");

        const taskIds: Record<string, string> = {};
        for (const t of content.tasks) taskIds[t.key] = createId("tsk");
        const taskRow = (i: number) => {
          const t = content.tasks[i]!;
          return {
            id: taskIds[t.key]!,
            projectId,
            milestoneId: t.milestoneKey ? milestoneIds[t.milestoneKey]! : null,
            parentTaskId: t.parentKey ? taskIds[t.parentKey]! : null,
            title: t.title,
            description: t.description,
            status: "todo",
            priority: t.priority,
            assigneeId: null,
            dueDate: preview.tasks[i]!.dueDate,
            createdAt: now,
            updatedAt: now,
          };
        };
        const indexes = content.tasks.map((_, i) => i);
        for (const group of [indexes.filter((i) => content.tasks[i]!.parentKey === null), indexes.filter((i) => content.tasks[i]!.parentKey !== null)]) {
          for (let i = 0; i < group.length; i += 50) tx.insert(tasks).values(group.slice(i, i + 50).map(taskRow)).run();
        }
        failAfter("tasks");

        for (let i = 0; i < content.dependencies.length; i += 200) {
          tx.insert(taskDependencies)
            .values(
              content.dependencies.slice(i, i + 200).map((d) => ({
                taskId: taskIds[d.taskKey]!,
                dependsOnTaskId: taskIds[d.dependsOnKey]!,
                createdAt: now,
              })),
            )
            .run();
        }
        failAfter("dependencies");

        const positions = new Map<string, number>();
        const checklistRows = content.checklist.map((c) => {
          const position = positions.get(c.taskKey) ?? 0;
          positions.set(c.taskKey, position + 1);
          return {
            id: createId("chk"),
            workspaceId: LOCAL_WORKSPACE_ID,
            taskId: taskIds[c.taskKey]!,
            position,
            text: c.text,
            done: false,
            createdAt: now,
            updatedAt: now,
          };
        });
        for (let i = 0; i < checklistRows.length; i += 100) tx.insert(taskChecklistItems).values(checklistRows.slice(i, i + 100)).run();
        failAfter("checklist");

        if (content.documents.length > 0) {
          tx.insert(knowledgeDocuments)
            .values(
              content.documents.map((d) => ({
                id: createId("doc"),
                projectId,
                title: d.title,
                content: d.content,
                category: d.category,
                pinned: d.pinned,
                createdAt: now,
                updatedAt: now,
                searchText: buildKnowledgeSearchText(d),
                searchIndexedAt: now,
              })),
            )
            .run();
        }
        failAfter("documents");

        tx.insert(activityEvents)
          .values({
            id: createId("act"),
            projectId,
            type: "project.created",
            message: `Created ${projectName} from template ${template.name}`,
            metadata: JSON.stringify({ source: "template", templateId, templateName: template.name }),
            createdAt: now,
          })
          .run();
        failAfter("activity");

        tx.update(projectTemplateApplications).set({ projectId }).where(eq(projectTemplateApplications.id, applicationId)).run();
        return { kind: "created" as const, project: { id: projectId, name: projectName }, milestones: milestoneIds, tasks: taskIds };
      });
    } catch (error) {
      if (error instanceof ApplyAbort) return error.result;
      if (isIdempotencyConflict(error)) {
        const replayed = this.replay(request, actor);
        if (!replayed) throw new Error("Idempotency record vanished after a unique violation.");
        return replayed;
      }
      throw error;
    }
  }

  /** The key's existing application: its project, a conflict, or null when the key is unused. */
  private replay(request: ApplyRequest, actor: ApplyActor): ApplyResult | null {
    const existing = db
      .select({ requestHash: projectTemplateApplications.requestHash, projectId: projectTemplateApplications.projectId })
      .from(projectTemplateApplications)
      .where(and(eq(projectTemplateApplications.actorKey, actor.actorKey), eq(projectTemplateApplications.idempotencyKey, request.idempotencyKey)))
      .get();
    if (!existing) return null;
    if (existing.requestHash !== request.requestHash) return { kind: "conflict", reason: "different_request" };
    if (!existing.projectId) return { kind: "conflict", reason: "project_deleted" };
    const project = db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.id, existing.projectId)).get();
    if (!project) return { kind: "conflict", reason: "project_deleted" };
    return { kind: "replayed", project };
  }
}

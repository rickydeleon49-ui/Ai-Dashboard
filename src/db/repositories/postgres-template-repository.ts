import "server-only";

/**
 * PostgreSQL TemplateRepository (Release 2D.3), accounts mode. Every query —
 * template, child rows, application records, and the rows an application
 * creates — is scoped by `workspace_id`. See
 * docs/design/2D.3-reusable-templates.md §2–§4, §9–§10.
 */
import { and, asc, count, eq, sql } from "drizzle-orm";
import { getPgDb } from "../pg-client";
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
  workspaceMembers,
  workspaces,
} from "../schema.pg";
import { createId } from "@/lib/ids";
import { MAX_TEMPLATES_PER_WORKSPACE } from "@/core/templates/limits";
import { previewTemplate } from "@/core/templates/validate";
import type { StoredTemplate, TemplateContent, TemplateSummary } from "@/core/templates/types";
import type { ProjectType } from "@/core/projects/types";
import type { TaskPriority } from "@/core/tasks/types";
import {
  InjectedApplyFailure,
  type ApplyActor,
  type ApplyFailurePoint,
  type ApplyRequest,
  type ApplyResult,
  type CreateResult,
  type TemplateRepository,
} from "./template-repository";

type Db = ReturnType<typeof getPgDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

/** True for a unique violation on the idempotency index, however the driver wraps it. */
function isIdempotencyConflict(error: unknown): boolean {
  for (let e: unknown = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const { code, constraint } = e as { code?: unknown; constraint?: unknown };
    if (code === "23505" && constraint === "project_template_application_key_uq") return true;
  }
  return false;
}

const utcMidnight = (day: string) => new Date(`${day}T00:00:00.000Z`);

class ApplyAbort extends Error {
  constructor(readonly result: ApplyResult) {
    super("apply aborted");
  }
}

async function readTemplate(db: Executor, workspaceId: string, id: string): Promise<StoredTemplate | null> {
  const [t] = await db
    .select()
    .from(projectTemplates)
    .where(and(eq(projectTemplates.id, id), eq(projectTemplates.workspaceId, workspaceId)))
    .limit(1);
  if (!t) return null;
  const owned = <T extends { templateId: unknown; workspaceId: unknown }>(table: T) =>
    and(eq(table.templateId as never, id), eq(table.workspaceId as never, workspaceId));
  const ms = await db.select().from(projectTemplateMilestones).where(owned(projectTemplateMilestones)).orderBy(asc(projectTemplateMilestones.position));
  const ts = await db.select().from(projectTemplateTasks).where(owned(projectTemplateTasks)).orderBy(asc(projectTemplateTasks.position));
  const ds = await db
    .select()
    .from(projectTemplateDependencies)
    .where(owned(projectTemplateDependencies))
    .orderBy(asc(projectTemplateDependencies.taskKey), asc(projectTemplateDependencies.dependsOnKey));
  const cs = await db
    .select()
    .from(projectTemplateChecklistItems)
    .where(owned(projectTemplateChecklistItems))
    .orderBy(asc(projectTemplateChecklistItems.taskKey), asc(projectTemplateChecklistItems.position));
  const docs = await db.select().from(projectTemplateDocuments).where(owned(projectTemplateDocuments)).orderBy(asc(projectTemplateDocuments.position));

  // Checklist items return to template (task) order.
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
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/** Inserts every child row of `content` for template `id`. Parents before subtasks (FK). */
async function insertChildren(tx: Tx, workspaceId: string, id: string, content: TemplateContent): Promise<void> {
  if (content.milestones.length > 0) {
    await tx.insert(projectTemplateMilestones).values(
      content.milestones.map((m, i) => ({
        id: createId("tpm"),
        templateId: id,
        workspaceId,
        key: m.key,
        position: i,
        title: m.title,
        description: m.description,
        targetOffset: m.targetOffset,
      })),
    );
  }
  const taskRow = (t: TemplateContent["tasks"][number]) => ({
    id: createId("tpt"),
    templateId: id,
    workspaceId,
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
  if (topLevel.length > 0) await tx.insert(projectTemplateTasks).values(topLevel.map(taskRow));
  if (subtasks.length > 0) await tx.insert(projectTemplateTasks).values(subtasks.map(taskRow));
  if (content.dependencies.length > 0) {
    await tx
      .insert(projectTemplateDependencies)
      .values(content.dependencies.map((d) => ({ templateId: id, workspaceId, taskKey: d.taskKey, dependsOnKey: d.dependsOnKey })));
  }
  if (content.checklist.length > 0) {
    const positions = new Map<string, number>();
    await tx.insert(projectTemplateChecklistItems).values(
      content.checklist.map((c) => {
        const position = positions.get(c.taskKey) ?? 0;
        positions.set(c.taskKey, position + 1);
        return { id: createId("tpc"), templateId: id, workspaceId, taskKey: c.taskKey, position, text: c.text };
      }),
    );
  }
  if (content.documents.length > 0) {
    await tx.insert(projectTemplateDocuments).values(
      content.documents.map((d, i) => ({
        id: createId("tpd"),
        templateId: id,
        workspaceId,
        position: i,
        title: d.title,
        content: d.content,
        category: d.category,
        pinned: d.pinned,
      })),
    );
  }
}

async function deleteChildren(tx: Tx, workspaceId: string, id: string): Promise<void> {
  // Dependencies and checklist first, then subtasks' parents cascade with tasks.
  for (const table of [projectTemplateDependencies, projectTemplateChecklistItems, projectTemplateTasks, projectTemplateMilestones, projectTemplateDocuments]) {
    await tx.delete(table).where(and(eq(table.templateId, id), eq(table.workspaceId, workspaceId)));
  }
}

/**
 * Locks the actor's membership row (FOR SHARE) and requires an active owner,
 * admin or member. Throws ApplyAbort(forbidden) otherwise — including when the
 * actor has no user id, which never happens for an authenticated hosted request.
 */
async function lockActiveEditor(tx: Tx, workspaceId: string, actor: ApplyActor): Promise<void> {
  if (!actor.userId) throw new ApplyAbort({ kind: "forbidden" });
  const [m] = await tx
    .select({ role: workspaceMembers.role, status: workspaceMembers.status })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actor.userId)))
    .for("share");
  if (!m || m.status !== "active" || m.role === "viewer") throw new ApplyAbort({ kind: "forbidden" });
}

/**
 * The key's existing application: its project, a conflict, or null when the
 * key is unused. Only called after lockActiveEditor in the same transaction.
 */
async function replayFrom(tx: Tx, workspaceId: string, request: ApplyRequest, actor: ApplyActor): Promise<ApplyResult | null> {
  const [existing] = await tx
    .select({ requestHash: projectTemplateApplications.requestHash, projectId: projectTemplateApplications.projectId })
    .from(projectTemplateApplications)
    .where(
      and(
        eq(projectTemplateApplications.workspaceId, workspaceId),
        eq(projectTemplateApplications.actorKey, actor.actorKey),
        eq(projectTemplateApplications.idempotencyKey, request.idempotencyKey),
      ),
    )
    .limit(1);
  if (!existing) return null;
  if (existing.requestHash !== request.requestHash) return { kind: "conflict", reason: "different_request" };
  if (!existing.projectId) return { kind: "conflict", reason: "project_deleted" };
  const [project] = await tx
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.id, existing.projectId), eq(projects.workspaceId, workspaceId)))
    .limit(1);
  if (!project) return { kind: "conflict", reason: "project_deleted" };
  return { kind: "replayed", project };
}

export class PostgresTemplateRepository implements TemplateRepository {
  async list(workspaceId: string): Promise<TemplateSummary[]> {
    const db = getPgDb();
    const rows = await db
      .select({ id: projectTemplates.id, name: projectTemplates.name, description: projectTemplates.description, updatedAt: projectTemplates.updatedAt })
      .from(projectTemplates)
      .where(eq(projectTemplates.workspaceId, workspaceId))
      .orderBy(asc(projectTemplates.name), asc(projectTemplates.id))
      .limit(MAX_TEMPLATES_PER_WORKSPACE);
    const counts = await db.execute(sql`
      SELECT t.id,
        (SELECT count(*) FROM project_template_milestone x WHERE x.template_id = t.id AND x.workspace_id = ${workspaceId})::int AS milestones,
        (SELECT count(*) FROM project_template_task x WHERE x.template_id = t.id AND x.workspace_id = ${workspaceId})::int AS tasks,
        (SELECT count(*) FROM project_template_dependency x WHERE x.template_id = t.id AND x.workspace_id = ${workspaceId})::int AS dependencies,
        (SELECT count(*) FROM project_template_checklist_item x WHERE x.template_id = t.id AND x.workspace_id = ${workspaceId})::int AS checklist,
        (SELECT count(*) FROM project_template_document x WHERE x.template_id = t.id AND x.workspace_id = ${workspaceId})::int AS documents
      FROM project_template t WHERE t.workspace_id = ${workspaceId}
    `);
    const byId = new Map((counts.rows as (TemplateSummary["counts"] & { id: string })[]).map((r) => [r.id, r]));
    return rows.map((r) => {
      const c = byId.get(r.id);
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        updatedAt: r.updatedAt.toISOString(),
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
    return readTemplate(getPgDb(), workspaceId, id);
  }

  async create(workspaceId: string, content: TemplateContent, createdBy: string | null): Promise<CreateResult> {
    return getPgDb().transaction(async (tx) => {
      // Serialize creation per workspace so the template cap holds under concurrency.
      await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
      const [{ n }] = (await tx.select({ n: count() }).from(projectTemplates).where(eq(projectTemplates.workspaceId, workspaceId))) as [{ n: number }];
      if (n >= MAX_TEMPLATES_PER_WORKSPACE) return { kind: "limit_reached" };
      const id = createId("tpl");
      await tx.insert(projectTemplates).values({
        id,
        workspaceId,
        name: content.name,
        description: content.description,
        projectName: content.project.name,
        projectDescription: content.project.description,
        projectType: content.project.type,
        projectStatus: content.project.status,
        createdBy,
      });
      await insertChildren(tx, workspaceId, id, content);
      return { kind: "created", id };
    });
  }

  async replace(workspaceId: string, id: string, content: TemplateContent): Promise<boolean> {
    return getPgDb().transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: projectTemplates.id })
        .from(projectTemplates)
        .where(and(eq(projectTemplates.id, id), eq(projectTemplates.workspaceId, workspaceId)))
        .for("update");
      if (!existing) return false;
      await deleteChildren(tx, workspaceId, id);
      await tx
        .update(projectTemplates)
        .set({
          name: content.name,
          description: content.description,
          projectName: content.project.name,
          projectDescription: content.project.description,
          projectType: content.project.type,
          projectStatus: content.project.status,
          updatedAt: new Date(),
        })
        .where(and(eq(projectTemplates.id, id), eq(projectTemplates.workspaceId, workspaceId)));
      await insertChildren(tx, workspaceId, id, content);
      return true;
    });
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    const deleted = await getPgDb()
      .delete(projectTemplates)
      .where(and(eq(projectTemplates.id, id), eq(projectTemplates.workspaceId, workspaceId)))
      .returning({ id: projectTemplates.id });
    return deleted.length > 0;
  }

  async apply(
    workspaceId: string,
    templateId: string,
    request: ApplyRequest,
    actor: ApplyActor,
    testFailAfter?: ApplyFailurePoint,
  ): Promise<ApplyResult> {
    const failAfter = (point: ApplyFailurePoint) => {
      if (testFailAfter === point) throw new InjectedApplyFailure(point);
    };
    try {
      return await getPgDb().transaction(async (tx) => {
        // Authorize first, holding the membership row, so a suspension or demotion
        // that commits first wins — for a replay as much as for a new application.
        await lockActiveEditor(tx, workspaceId, actor);

        // A key that already created a project answers from its record, even if
        // the template has since been deleted (design note §13).
        const prior = await replayFrom(tx, workspaceId, request, actor);
        if (prior) return prior;

        const [template] = await tx
          .select({ id: projectTemplates.id, name: projectTemplates.name })
          .from(projectTemplates)
          .where(and(eq(projectTemplates.id, templateId), eq(projectTemplates.workspaceId, workspaceId)))
          .for("share");
        if (!template) throw new ApplyAbort({ kind: "not_found" });

        // The idempotency claim. A concurrent request with the same key blocks
        // here until this transaction ends, then fails on the unique index.
        const applicationId = createId("tap");
        await tx.insert(projectTemplateApplications).values({
          id: applicationId,
          workspaceId,
          actorKey: actor.actorKey,
          idempotencyKey: request.idempotencyKey,
          requestHash: request.requestHash,
          templateId,
          templateWorkspaceId: workspaceId,
          projectId: null,
          projectWorkspaceId: null,
        });
        failAfter("application");

        const content = await readTemplate(tx, workspaceId, templateId);
        if (!content) throw new ApplyAbort({ kind: "not_found" });
        const preview = previewTemplate(templateId, content, request.startDate, request.name);
        if (preview.errors.length > 0) throw new ApplyAbort({ kind: "invalid", issues: preview.errors });

        const projectId = createId("prj");
        const projectName = preview.projectName;
        await tx.insert(projects).values({
          id: projectId,
          workspaceId,
          name: projectName,
          description: content.project.description,
          source: "manual",
          type: content.project.type,
          status: content.project.status,
        });
        failAfter("project");

        const milestoneIds: Record<string, string> = {};
        if (content.milestones.length > 0) {
          await tx.insert(milestones).values(
            preview.milestones.map((m, i) => {
              milestoneIds[m.key] = createId("mst");
              return {
                id: milestoneIds[m.key]!,
                workspaceId,
                projectId,
                title: m.title,
                description: content.milestones[i]!.description,
                status: "open",
                dueDate: m.targetDate ? utcMidnight(m.targetDate) : null,
              };
            }),
          );
        }
        failAfter("milestones");

        const taskIds: Record<string, string> = {};
        for (const t of content.tasks) taskIds[t.key] = createId("tsk");
        const taskRow = (i: number) => {
          const t = content.tasks[i]!;
          const p = preview.tasks[i]!;
          return {
            id: taskIds[t.key]!,
            workspaceId,
            projectId,
            milestoneId: t.milestoneKey ? milestoneIds[t.milestoneKey]! : null,
            parentTaskId: t.parentKey ? taskIds[t.parentKey]! : null,
            title: t.title,
            description: t.description,
            status: "todo",
            priority: t.priority,
            assigneeId: null,
            dueDate: p.dueDate ? utcMidnight(p.dueDate) : null,
          };
        };
        const indexes = content.tasks.map((_, i) => i);
        const top = indexes.filter((i) => content.tasks[i]!.parentKey === null);
        const sub = indexes.filter((i) => content.tasks[i]!.parentKey !== null);
        if (top.length > 0) await tx.insert(tasks).values(top.map(taskRow));
        if (sub.length > 0) await tx.insert(tasks).values(sub.map(taskRow));
        failAfter("tasks");

        if (content.dependencies.length > 0) {
          await tx.insert(taskDependencies).values(
            content.dependencies.map((d) => ({ taskId: taskIds[d.taskKey]!, dependsOnTaskId: taskIds[d.dependsOnKey]!, workspaceId })),
          );
        }
        failAfter("dependencies");

        if (content.checklist.length > 0) {
          const positions = new Map<string, number>();
          await tx.insert(taskChecklistItems).values(
            content.checklist.map((c) => {
              const position = positions.get(c.taskKey) ?? 0;
              positions.set(c.taskKey, position + 1);
              return { id: createId("chk"), workspaceId, taskId: taskIds[c.taskKey]!, position, text: c.text, done: false };
            }),
          );
        }
        failAfter("checklist");

        if (content.documents.length > 0) {
          await tx.insert(knowledgeDocuments).values(
            content.documents.map((d) => ({
              id: createId("doc"),
              workspaceId,
              projectId,
              title: d.title,
              content: d.content,
              category: d.category,
              pinned: d.pinned,
            })),
          );
        }
        failAfter("documents");

        await tx.insert(activityEvents).values({
          id: createId("act"),
          workspaceId,
          projectId,
          type: "project.created",
          message: `Created ${projectName} from template ${template.name}`,
          metadata: { source: "template", templateId, templateName: template.name },
        });
        failAfter("activity");

        await tx
          .update(projectTemplateApplications)
          .set({ projectId, projectWorkspaceId: workspaceId })
          .where(and(eq(projectTemplateApplications.id, applicationId), eq(projectTemplateApplications.workspaceId, workspaceId)));

        return { kind: "created" as const, project: { id: projectId, name: projectName }, milestones: milestoneIds, tasks: taskIds };
      });
    } catch (error) {
      if (error instanceof ApplyAbort) return error.result;
      if (isIdempotencyConflict(error)) {
        // A concurrent request with the same key committed first. Replay it in a
        // fresh transaction that re-authorizes before reading the record.
        return getPgDb().transaction(async (tx) => {
          try {
            await lockActiveEditor(tx, workspaceId, actor);
          } catch (e) {
            if (e instanceof ApplyAbort) return e.result;
            throw e;
          }
          const replayed = await replayFrom(tx, workspaceId, request, actor);
          if (!replayed) throw new Error("Idempotency record vanished after a unique violation.");
          return replayed;
        });
      }
      throw error;
    }
  }
}

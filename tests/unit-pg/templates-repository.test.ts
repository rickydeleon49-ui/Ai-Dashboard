/**
 * Release 2D.3 templates — PostgreSQL repository.
 *
 * 1. Parity with SQLite on the shared fixture (tests/helpers/template-fixtures.ts).
 * 2. Rollback: an injected failure at every stage leaves no project, child
 *    row or application record in the workspace, and the key stays usable.
 * 3. Idempotency under concurrency: simultaneous applications with the same
 *    key create exactly one project; the rest replay it.
 * 4. Isolation: another workspace can never read, replace, delete or apply a
 *    template, and composite foreign keys refuse cross-template references.
 * 5. Authorization is re-checked inside the transaction — before a replay too:
 *    a member who lost access cannot replay a key they used earlier.
 * 6. The database refuses rows that claim a workspace other than their
 *    template's, including nested references and application links.
 * 7. Upgrade: migration 0016 applies on a populated pre-template database.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { Client } from "pg";
import { cleanup, migrate } from "../helpers/db.pg";
import { FIXTURE_START, FULL_TEMPLATE, assertCreatedProject, requestKey, type CreatedProjectShape } from "../helpers/template-fixtures";
import type { ApplyFailurePoint } from "../../src/db/repositories/template-repository";
import type { TemplateContent } from "../../src/core/templates/types";

const WA = "ws-tpl-a";
const WB = "ws-tpl-b";
const U = {
  owner: "c1000000-0000-4000-8000-000000000001",
  viewer: "c2000000-0000-4000-8000-000000000002",
  suspended: "c3000000-0000-4000-8000-000000000003",
  outsider: "c4000000-0000-4000-8000-000000000004",
};

type Repo = import("../../src/db/repositories/postgres-template-repository").PostgresTemplateRepository;
let repo: Repo;
let db: ReturnType<typeof import("../../src/db/pg-client").getPgDb>;
let schema: typeof import("../../src/db/schema.pg");
let projects: import("../../src/db/repositories/postgres-project-repository").PostgresProjectRepository;
let tasks: import("../../src/db/repositories/postgres-task-repository").PostgresTaskRepository;
let milestones: import("../../src/db/repositories/postgres-milestone-repository").PostgresMilestoneRepository;
let docs: import("../../src/db/repositories/postgres-knowledge-document-repository").PostgresKnowledgeDocumentRepository;
let content: TemplateContent;

const owner = { userId: U.owner, actorKey: U.owner };

before(async () => {
  await migrate();
  db = (await import("../../src/db/pg-client")).getPgDb();
  schema = await import("../../src/db/schema.pg");
  repo = new (await import("../../src/db/repositories/postgres-template-repository")).PostgresTemplateRepository();
  projects = new (await import("../../src/db/repositories/postgres-project-repository")).PostgresProjectRepository();
  tasks = new (await import("../../src/db/repositories/postgres-task-repository")).PostgresTaskRepository();
  milestones = new (await import("../../src/db/repositories/postgres-milestone-repository")).PostgresMilestoneRepository();
  docs = new (await import("../../src/db/repositories/postgres-knowledge-document-repository")).PostgresKnowledgeDocumentRepository();
  content = (await import("../../src/core/templates/schema")).templateContentSchema.parse(FULL_TEMPLATE) as TemplateContent;

  await db.insert(schema.users).values([
    { id: U.owner, name: "Tess Owner", email: "tess@example.com" },
    { id: U.viewer, name: "Val Viewer", email: "val@example.com" },
    { id: U.suspended, name: "Sus Pended", email: "sus@example.com" },
    { id: U.outsider, name: "Out Sider", email: "out@example.com" },
  ]);
  await db.insert(schema.workspaces).values([
    { id: WA, name: "Templates A", slug: WA, kind: "team" },
    { id: WB, name: "Templates B", slug: WB, kind: "team" },
  ]);
  await db.insert(schema.workspaceMembers).values([
    { workspaceId: WA, userId: U.owner, role: "owner", status: "active" },
    { workspaceId: WA, userId: U.viewer, role: "viewer", status: "active" },
    { workspaceId: WA, userId: U.suspended, role: "member", status: "suspended" },
    { workspaceId: WB, userId: U.outsider, role: "owner", status: "active" },
  ]);
});

after(() => cleanup());

async function newTemplate(workspaceId = WA): Promise<string> {
  const r = await repo.create(workspaceId, content, workspaceId === WA ? U.owner : U.outsider);
  assert.equal(r.kind, "created");
  return (r as { id: string }).id;
}

const req = (key: string, extra: Partial<{ startDate: string; name: string; requestHash: string }> = {}) => ({
  idempotencyKey: key,
  startDate: extra.startDate ?? FIXTURE_START,
  name: extra.name,
  requestHash: extra.requestHash ?? crypto.createHash("sha256").update(`${extra.startDate ?? FIXTURE_START}|${extra.name ?? ""}`).digest("hex"),
});

/** Rows in `workspaceId` for every table an application writes. */
async function counts(workspaceId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of ["project", "milestone", "task", "task_dependency", "task_checklist_item", "knowledge_document", "activity_event", "project_template_application"]) {
    const r = await db.execute(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = '${workspaceId}'` as never);
    out[table] = (r.rows[0] as { n: number }).n;
  }
  return out;
}

async function describeProject(workspaceId: string, projectId: string): Promise<CreatedProjectShape> {
  const project = (await projects.findById(workspaceId, projectId))!;
  const ms = await milestones.list(workspaceId, projectId);
  const ts = await tasks.list(workspaceId, projectId);
  const titleOfTask = new Map(ts.map((t) => [t.id, t.title]));
  const titleOfMilestone = new Map(ms.map((m) => [m.id, m.title]));
  const deps = (
    await db.execute(
      `SELECT task_id, depends_on_task_id FROM task_dependency WHERE workspace_id = '${workspaceId}' AND task_id IN (SELECT id FROM task WHERE project_id = '${projectId}')` as never,
    )
  ).rows as { task_id: string; depends_on_task_id: string }[];
  const checklist = (
    await db.execute(
      `SELECT task_id, position, text, done FROM task_checklist_item WHERE workspace_id = '${workspaceId}' AND task_id IN (SELECT id FROM task WHERE project_id = '${projectId}')` as never,
    )
  ).rows as { task_id: string; position: number; text: string; done: boolean }[];
  const documents = await docs.list(workspaceId, projectId);
  return {
    project: { name: project.name, description: project.description, type: project.type, status: project.status, source: project.source },
    milestones: ms.map((m) => ({ title: m.title, status: m.status, dueDate: m.dueDate ? m.dueDate.slice(0, 10) : null })),
    tasks: ts.map((t) => ({
      title: t.title,
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate ? t.dueDate.slice(0, 10) : null,
      milestone: t.milestoneId ? titleOfMilestone.get(t.milestoneId)! : null,
      parent: t.parentTaskId ? titleOfTask.get(t.parentTaskId)! : null,
      assigneeId: t.assigneeId,
    })),
    dependencies: deps.map((d) => `${titleOfTask.get(d.task_id)}>${titleOfTask.get(d.depends_on_task_id)}`),
    checklist: checklist.map((c) => `${titleOfTask.get(c.task_id)}#${c.position}:${c.text}:${c.done ? "done" : "open"}`).sort(),
    documents: documents.map((d) => ({ title: d.title, category: d.category, pinned: d.pinned })),
    blocked: ts.filter((t) => t.blocked).map((t) => t.title),
  };
}

describe("postgres templates: parity and CRUD", () => {
  it("applies the shared fixture exactly as SQLite does", async () => {
    const id = await newTemplate();
    const r = await repo.apply(WA, id, req(requestKey("pg-full")), owner);
    assert.equal(r.kind, "created");
    if (r.kind !== "created") return;
    assertCreatedProject(await describeProject(WA, r.project.id));
    const events = (await db.execute(`SELECT metadata FROM activity_event WHERE project_id = '${r.project.id}'` as never)).rows as { metadata: unknown }[];
    assert.deepEqual(events.map((e) => e.metadata), [{ source: "template", templateId: id, templateName: "Launch template" }]);
  });

  it("writes template documents with fresh derived search text (Release 2E.1), source untouched", async () => {
    const id = await newTemplate();
    const r = await repo.apply(WA, id, req(requestKey("pg-search-text")), owner);
    assert.equal(r.kind, "created");
    if (r.kind !== "created") return;
    const rows = (
      await db.execute(
        `SELECT title, content, search_text, search_indexed_at = updated_at AS fresh FROM knowledge_document WHERE project_id = '${r.project.id}' ORDER BY title` as never,
      )
    ).rows as { title: string; content: string; search_text: string | null; fresh: boolean }[];
    assert.deepEqual(
      rows.map((row) => [row.title, row.content, row.search_text, row.fresh]),
      [
        ["FAQ", "Questions.", "faq questions.", true],
        ["Launch runbook", "# Runbook\nSteps.", "launch runbook operations runbook steps.", true],
      ],
    );
    assert.deepEqual((await docs.search(WA, r.project.id, { search: "steps" })).documents.map((d) => d.title), ["Launch runbook"]);
  });

  it("round-trips the document and cascades child rows on delete", async () => {
    const id = await newTemplate();
    const stored = (await repo.get(WA, id))!;
    assert.deepEqual(stored.tasks, content.tasks);
    assert.deepEqual(stored.checklist, content.checklist);
    assert.ok(await repo.delete(WA, id));
    for (const table of ["project_template_milestone", "project_template_task", "project_template_dependency", "project_template_checklist_item", "project_template_document"]) {
      const r = await db.execute(`SELECT count(*)::int AS n FROM ${table} WHERE template_id = '${id}'` as never);
      assert.equal((r.rows[0] as { n: number }).n, 0, table);
    }
  });
});

describe("postgres templates: atomic application", () => {
  for (const point of ["application", "project", "milestones", "tasks", "dependencies", "checklist", "documents", "activity"] as ApplyFailurePoint[]) {
    it(`leaves nothing behind after a failure injected after "${point}"`, async () => {
      const id = await newTemplate();
      const before = await counts(WA);
      const key = requestKey(`pg-fail-${point}`);
      await assert.rejects(repo.apply(WA, id, req(key), owner, point), /Injected failure/);
      assert.deepEqual(await counts(WA), before);
      assert.equal((await repo.apply(WA, id, req(key), owner)).kind, "created", "the key was not consumed");
    });
  }

  it("simultaneous applications with the same key create exactly one project", async () => {
    const id = await newTemplate();
    const key = requestKey("pg-race");
    const before = await counts(WA);
    const results = await Promise.all(Array.from({ length: 8 }, () => repo.apply(WA, id, req(key), owner)));
    const created = results.filter((r) => r.kind === "created");
    const replayed = results.filter((r) => r.kind === "replayed");
    assert.equal(created.length, 1, JSON.stringify(results.map((r) => r.kind)));
    assert.equal(replayed.length, 7);
    const projectId = (created[0] as { project: { id: string } }).project.id;
    assert.ok(replayed.every((r) => (r as { project: { id: string } }).project.id === projectId));
    const after = await counts(WA);
    assert.equal(after.project, before.project! + 1);
    assert.equal(after.project_template_application, before.project_template_application! + 1);
    assert.equal(after.task, before.task! + 5);
  });

  it("the same key with a different request conflicts, even concurrently", async () => {
    const id = await newTemplate();
    const key = requestKey("pg-diff");
    const results = await Promise.all([
      repo.apply(WA, id, req(key, { startDate: "2028-02-27" }), owner),
      repo.apply(WA, id, req(key, { startDate: "2028-03-05" }), owner),
    ]);
    assert.deepEqual(results.map((r) => r.kind).sort(), ["conflict", "created"]);
  });

  it("scopes keys by workspace and actor", async () => {
    const a = await newTemplate(WA);
    const b = await newTemplate(WB);
    const key = requestKey("pg-shared");
    assert.equal((await repo.apply(WA, a, req(key), owner)).kind, "created");
    assert.equal((await repo.apply(WB, b, req(key), { userId: U.outsider, actorKey: U.outsider })).kind, "created");
  });

  it("re-checks authorization inside the transaction", async () => {
    const id = await newTemplate();
    const before = await counts(WA);
    for (const userId of [U.viewer, U.suspended, U.outsider]) {
      assert.deepEqual(await repo.apply(WA, id, req(requestKey(`pg-auth-${userId.slice(0, 2)}`)), { userId, actorKey: userId }), { kind: "forbidden" });
    }
    assert.deepEqual(await counts(WA), before);
  });

  it("refuses an application whose dates leave the calendar, writing nothing", async () => {
    const id = await newTemplate();
    const before = await counts(WA);
    const r = await repo.apply(WA, id, req(requestKey("pg-late"), { startDate: "9999-12-20" }), owner);
    assert.equal(r.kind, "invalid");
    assert.deepEqual(await counts(WA), before);
  });

  it("deleting the template leaves the created project; a later retry still returns it", async () => {
    const id = await newTemplate();
    const key = requestKey("pg-keep");
    const r = await repo.apply(WA, id, req(key), owner);
    assert.ok(await repo.delete(WA, id));
    if (r.kind !== "created") throw new Error("expected created");
    assertCreatedProject(await describeProject(WA, r.project.id));
    assert.deepEqual(await repo.apply(WA, id, req(key), owner), { kind: "replayed", project: r.project });
  });
});

describe("postgres templates: workspace isolation", () => {
  it("another workspace can never read, list, replace, delete or apply a template", async () => {
    const id = await newTemplate(WA);
    assert.equal(await repo.get(WB, id), null);
    assert.ok(!(await repo.list(WB)).some((t) => t.id === id));
    assert.equal(await repo.replace(WB, id, content), false);
    assert.equal(await repo.delete(WB, id), false);
    const before = await counts(WB);
    assert.deepEqual(await repo.apply(WB, id, req(requestKey("pg-foreign")), { userId: U.outsider, actorKey: U.outsider }), { kind: "not_found" });
    assert.deepEqual(await counts(WB), before);
    assert.ok(await repo.get(WA, id), "workspace A still has it");
  });

  it("composite foreign keys refuse references to another template's items", async () => {
    const a = await newTemplate(WA);
    const b = await newTemplate(WA);
    // A task in template B naming template A's milestone key "beta" resolves only within B.
    await db.delete(schema.projectTemplateTasks).where((await import("drizzle-orm")).eq(schema.projectTemplateTasks.templateId, b));
    await db.delete(schema.projectTemplateMilestones).where((await import("drizzle-orm")).eq(schema.projectTemplateMilestones.templateId, b));
    await assert.rejects(
      db.insert(schema.projectTemplateTasks).values({
        id: "tpt_forged",
        templateId: b,
        workspaceId: WA,
        key: "forged",
        position: 0,
        title: "Forged",
        milestoneKey: "beta",
      }),
      (e: unknown) => /foreign key/i.test(String((e as { cause?: { message?: string } }).cause?.message ?? e)),
    );
    assert.ok(await repo.get(WA, a));
  });
});

describe("postgres templates: replay re-authorizes the caller", () => {
  let n = 0;
  /** A fresh active member of WA who has applied a template with `key`. */
  async function memberWhoApplied(label: string) {
    const userId = `c5000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    await db.insert(schema.users).values({ id: userId, name: `Member ${n}`, email: `member-${n}@example.com` });
    await db.insert(schema.workspaceMembers).values({ workspaceId: WA, userId, role: "member", status: "active" });
    const id = await newTemplate();
    const key = requestKey(`pg-replay-${label}`);
    const actor = { userId, actorKey: userId };
    const first = await repo.apply(WA, id, req(key), actor);
    assert.equal(first.kind, "created");
    return { id, key, actor, userId, project: (first as { project: { id: string; name: string } }).project };
  }

  const membership = (userId: string) =>
    and(eq(schema.workspaceMembers.workspaceId, WA), eq(schema.workspaceMembers.userId, userId));

  const revocations: [string, (userId: string) => Promise<unknown>][] = [
    ["demoted to viewer", (u) => db.update(schema.workspaceMembers).set({ role: "viewer" }).where(membership(u))],
    ["suspended", (u) => db.update(schema.workspaceMembers).set({ status: "suspended" }).where(membership(u))],
    ["removed", (u) => db.update(schema.workspaceMembers).set({ status: "removed" }).where(membership(u))],
    ["no longer a member", (u) => db.delete(schema.workspaceMembers).where(membership(u))],
  ];

  for (const [state, revoke] of revocations) {
    it(`a member ${state} after applying cannot replay the key or see the project`, async () => {
      const m = await memberWhoApplied(state.replaceAll(" ", "-"));
      await revoke(m.userId);
      const before = await counts(WA);
      const r = await repo.apply(WA, m.id, req(m.key), m.actor);
      assert.deepEqual(r, { kind: "forbidden" }, "only the kind is returned: no project id or name");
      assert.deepEqual(await counts(WA), before);
    });
  }

  it("an unchanged active member still receives the replay, also after the template is deleted", async () => {
    const m = await memberWhoApplied("unchanged");
    assert.deepEqual(await repo.apply(WA, m.id, req(m.key), m.actor), { kind: "replayed", project: m.project });
    assert.ok(await repo.delete(WA, m.id));
    assert.deepEqual(await repo.apply(WA, m.id, req(m.key), m.actor), { kind: "replayed", project: m.project });
  });

  it("a demotion that commits while the replay waits for the membership lock wins", async () => {
    const m = await memberWhoApplied("race");
    const other = new Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      await other.query("BEGIN");
      await other.query(`UPDATE workspace_member SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2`, [WA, m.userId]);
      // The replay blocks on FOR SHARE until the demotion commits, then reads the new role.
      const pending = repo.apply(WA, m.id, req(m.key), m.actor);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await other.query("COMMIT");
      assert.deepEqual(await pending, { kind: "forbidden" });
    } finally {
      await other.end();
    }
  });

  it("the same key conflicts for a different request and after the project was deleted", async () => {
    const m = await memberWhoApplied("conflicts");
    assert.deepEqual(await repo.apply(WA, m.id, req(m.key, { startDate: "2028-03-05" }), m.actor), { kind: "conflict", reason: "different_request" });
    assert.ok(await projects.delete(WA, m.project.id));
    assert.deepEqual(await repo.apply(WA, m.id, req(m.key), m.actor), { kind: "conflict", reason: "project_deleted" });
  });
});

describe("postgres templates: the database enforces workspace consistency", () => {
  let tA: string;
  let tB: string;
  let pA: string;
  const fkOrCheck = (e: unknown) =>
    /foreign key|check constraint/i.test(String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message ?? e));

  before(async () => {
    tA = await newTemplate(WA);
    tB = await newTemplate(WB);
    const r = await repo.apply(WA, tA, req(requestKey("pg-consistency")), owner);
    assert.equal(r.kind, "created");
    pA = (r as { project: { id: string } }).project.id;
  });

  it("accepts every same-workspace relation", async () => {
    await db.insert(schema.projectTemplateMilestones).values({ id: "tpm_ok", templateId: tA, workspaceId: WA, key: "ok-m", position: 90, title: "OK" });
    await db.insert(schema.projectTemplateTasks).values({ id: "tpt_ok", templateId: tA, workspaceId: WA, key: "ok-t", position: 90, title: "OK", milestoneKey: "ok-m" });
    await db.insert(schema.projectTemplateTasks).values({ id: "tpt_ok_sub", templateId: tA, workspaceId: WA, key: "ok-sub", position: 91, title: "OK sub", parentKey: "ok-t" });
    await db.insert(schema.projectTemplateDependencies).values({ templateId: tA, workspaceId: WA, taskKey: "ok-t", dependsOnKey: "spec" });
    await db.insert(schema.projectTemplateChecklistItems).values({ id: "tpc_ok", templateId: tA, workspaceId: WA, taskKey: "ok-t", position: 0, text: "OK" });
    await db.insert(schema.projectTemplateDocuments).values({ id: "tpd_ok", templateId: tA, workspaceId: WA, position: 90, title: "OK" });
    await db.insert(schema.projectTemplateApplications).values({
      id: "tap_ok",
      workspaceId: WA,
      actorKey: U.owner,
      idempotencyKey: requestKey("pg-direct-ok"),
      requestHash: "h",
      templateId: tA,
      templateWorkspaceId: WA,
      projectId: pA,
      projectWorkspaceId: WA,
    });
    const stored = (await repo.get(WA, tA))!;
    assert.ok(stored.tasks.some((t) => t.key === "ok-sub" && t.parentKey === "ok-t"));
  });

  it("rejects a real template id paired with another workspace in every child table", async () => {
    const forged: [string, () => Promise<unknown>][] = [
      ["milestone", () => db.insert(schema.projectTemplateMilestones).values({ id: "tpm_x", templateId: tA, workspaceId: WB, key: "x", position: 99, title: "X" })],
      ["task", () => db.insert(schema.projectTemplateTasks).values({ id: "tpt_x", templateId: tA, workspaceId: WB, key: "x", position: 99, title: "X" })],
      ["dependency", () => db.insert(schema.projectTemplateDependencies).values({ templateId: tA, workspaceId: WB, taskKey: "build", dependsOnKey: "retro" })],
      ["checklist", () => db.insert(schema.projectTemplateChecklistItems).values({ id: "tpc_x", templateId: tA, workspaceId: WB, taskKey: "spec", position: 99, text: "X" })],
      ["document", () => db.insert(schema.projectTemplateDocuments).values({ id: "tpd_x", templateId: tA, workspaceId: WB, position: 99, title: "X" })],
    ];
    for (const [table, insert] of forged) await assert.rejects(insert(), fkOrCheck, table);
  });

  it("rejects nested references that cross workspaces", async () => {
    // Rows that claim workspace A for template B's items (and the reverse) name
    // keys that exist in the other template, so only the workspace is wrong.
    const forged: [string, () => Promise<unknown>][] = [
      ["task -> milestone", () => db.insert(schema.projectTemplateTasks).values({ id: "tpt_xm", templateId: tB, workspaceId: WA, key: "xm", position: 99, title: "X", milestoneKey: "beta" })],
      ["task -> parent", () => db.insert(schema.projectTemplateTasks).values({ id: "tpt_xp", templateId: tB, workspaceId: WA, key: "xp", position: 99, title: "X", parentKey: "spec" })],
      ["dependency -> task", () => db.insert(schema.projectTemplateDependencies).values({ templateId: tB, workspaceId: WA, taskKey: "build", dependsOnKey: "retro" })],
      ["checklist -> task", () => db.insert(schema.projectTemplateChecklistItems).values({ id: "tpc_xt", templateId: tB, workspaceId: WA, taskKey: "spec", position: 99, text: "X" })],
    ];
    for (const [relation, insert] of forged) await assert.rejects(insert(), fkOrCheck, relation);

    // Every nested foreign key carries workspace_id, not only the template-level one.
    const fks = (
      await db.execute(sql`
        SELECT c.conname AS name, array_to_string(array_agg(a.attname ORDER BY k.ord), ',') AS cols
        FROM pg_constraint c
        CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.contype = 'f' AND c.conname LIKE 'project_template%' AND c.conname NOT LIKE '%workspace_id%'
        GROUP BY c.conname ORDER BY c.conname`)
    ).rows as { name: string; cols: string }[];
    assert.deepEqual(Object.fromEntries(fks.map((f) => [f.name, f.cols])), {
      project_template_application_project_fk: "project_id,project_workspace_id",
      project_template_application_template_fk: "template_id,template_workspace_id",
      project_template_checklist_item_task_fk: "template_id,workspace_id,task_key",
      project_template_checklist_item_template_fk: "template_id,workspace_id",
      project_template_created_by_user_id_fk: "created_by",
      project_template_dependency_depends_on_fk: "template_id,workspace_id,depends_on_key",
      project_template_dependency_task_fk: "template_id,workspace_id,task_key",
      project_template_dependency_template_fk: "template_id,workspace_id",
      project_template_document_template_fk: "template_id,workspace_id",
      project_template_milestone_template_fk: "template_id,workspace_id",
      project_template_task_milestone_fk: "template_id,workspace_id,milestone_key",
      project_template_task_parent_fk: "template_id,workspace_id,parent_key",
      project_template_task_template_fk: "template_id,workspace_id",
    });
  });

  it("rejects application records that point at another workspace's template or project", async () => {
    let i = 0;
    const application = (over: Partial<typeof schema.projectTemplateApplications.$inferInsert>) =>
      db.insert(schema.projectTemplateApplications).values({
        id: `tap_x${++i}`,
        workspaceId: WB,
        actorKey: U.outsider,
        idempotencyKey: requestKey(`pg-direct-x${i}`),
        requestHash: "h",
        ...over,
      });
    const forged: [string, () => Promise<unknown>][] = [
      ["template, honest link workspace", () => application({ templateId: tA, templateWorkspaceId: WA })],
      ["template, forged link workspace", () => application({ templateId: tA, templateWorkspaceId: WB })],
      ["template, link workspace omitted", () => application({ templateId: tA })],
      ["project, honest link workspace", () => application({ projectId: pA, projectWorkspaceId: WA })],
      ["project, forged link workspace", () => application({ projectId: pA, projectWorkspaceId: WB })],
      ["project, link workspace omitted", () => application({ projectId: pA })],
    ];
    for (const [label, insert] of forged) await assert.rejects(insert(), fkOrCheck, label);
    // Its own workspace's template is fine.
    await application({ templateId: tB, templateWorkspaceId: WB });
  });

  it("clears both link columns when the template or project is deleted", async () => {
    const t = await newTemplate(WA);
    const key = requestKey("pg-links");
    const r = await repo.apply(WA, t, req(key), owner);
    if (r.kind !== "created") throw new Error("expected created");
    const links = async () =>
      (
        await db.execute(sql`
          SELECT template_id, template_workspace_id, project_id, project_workspace_id
          FROM project_template_application WHERE workspace_id = ${WA} AND idempotency_key = ${key}`)
      ).rows[0];
    assert.deepEqual(await links(), { template_id: t, template_workspace_id: WA, project_id: r.project.id, project_workspace_id: WA });
    assert.ok(await repo.delete(WA, t));
    assert.ok(await projects.delete(WA, r.project.id));
    assert.deepEqual(await links(), { template_id: null, template_workspace_id: null, project_id: null, project_workspace_id: null });
  });
});

describe("postgres templates: upgrade from the pre-template schema", () => {
  it("applies migration 0016 on a populated database without touching existing rows", async () => {
    const adminUrl = process.env.TEST_DATABASE_ADMIN_URL?.trim() || "postgres://ai_dashboard:ai_dashboard_dev@localhost:5432/postgres";
    const name = `cc_tpl_upgrade_${crypto.randomBytes(5).toString("hex")}`;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      const dir = path.resolve(process.cwd(), "drizzle-pg");
      const journal = JSON.parse(fs.readFileSync(path.join(dir, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
      const run = async (entry: { tag: string }) => {
        for (const chunk of fs.readFileSync(path.join(dir, `${entry.tag}.sql`), "utf8").split("--> statement-breakpoint")) {
          if (chunk.trim()) await client.query(chunk);
        }
      };
      const templateMigration = journal.entries.find((e) => e.tag.endsWith("_reusable_templates"))!;
      for (const e of journal.entries.filter((e) => e.idx < templateMigration.idx)) await run(e);
      await client.query(`INSERT INTO "user" (id, email) VALUES ('u1', 'u1@example.com')`);
      await client.query(`INSERT INTO workspace (id, name, slug, kind, created_by) VALUES ('w1', 'W', 'w', 'team', 'u1')`);
      await client.query(`INSERT INTO project (id, workspace_id, name) VALUES ('p1', 'w1', 'Existing project')`);
      await client.query(`INSERT INTO milestone (id, workspace_id, project_id, title) VALUES ('m1', 'w1', 'p1', 'M')`);
      await client.query(`INSERT INTO task (id, workspace_id, project_id, milestone_id, title) VALUES ('k1', 'w1', 'p1', 'm1', 'T')`);
      const snapshot = async () =>
        (await client.query(`SELECT (SELECT json_agg(p) FROM project p) AS p, (SELECT json_agg(m) FROM milestone m) AS m, (SELECT json_agg(t) FROM task t) AS t`)).rows[0];
      const existing = await snapshot();
      await run(templateMigration);
      assert.deepEqual(await snapshot(), existing, "existing records are unchanged");
      const tables = await client.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name LIKE 'project_template%'`);
      assert.equal(tables.rows[0].n, 7);
      // The workspace-aware links work on the upgraded database, and refuse a mismatch.
      await client.query(`INSERT INTO project_template (id, workspace_id, name, project_name) VALUES ('t1', 'w1', 'T', 'P')`);
      await client.query(
        `INSERT INTO project_template_application (id, workspace_id, actor_key, idempotency_key, request_hash, template_id, template_workspace_id, project_id, project_workspace_id)
         VALUES ('a1', 'w1', 'u1', 'k', 'h', 't1', 'w1', 'p1', 'w1')`,
      );
      await client.query(`INSERT INTO workspace (id, name, slug, kind, created_by) VALUES ('w2', 'W2', 'w2', 'team', 'u1')`);
      await assert.rejects(client.query(`INSERT INTO project_template_milestone (id, template_id, workspace_id, key, position, title) VALUES ('x', 't1', 'w2', 'x', 0, 'X')`), /foreign key/);
    } finally {
      await client.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
    }
  });
});

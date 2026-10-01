/**
 * Release 2D.3 templates — desktop (SQLite), through the real routes, with no
 * account and no network.
 *
 * 1. CRUD, strict validation and child-row cascades.
 * 2. Preview computes on the server and writes nothing.
 * 3. Application creates the complete project (shared fixture), atomically.
 * 4. Retry: same key → same project; different request → 409; injected
 *    failures at every stage leave no rows and keep the key usable.
 * 5. Deleting a template never touches projects created from it.
 * 6. Workload limit on the number of templates.
 * 7. Upgrade: migration 0010 applies on a populated pre-template database.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db";
import { FIXTURE_START, FULL_TEMPLATE, assertCreatedProject, requestKey, type CreatedProjectShape } from "../helpers/template-fixtures";
import { LOCAL_WORKSPACE_ID } from "../../src/db/repositories/project-repository";
import type { ApplyFailurePoint } from "../../src/db/repositories/template-repository";

type Repos = typeof import("../../src/db/repositories");
let repos: Repos;
let collection: typeof import("../../src/app/api/templates/route");
let item: typeof import("../../src/app/api/templates/[id]/route");
let preview: typeof import("../../src/app/api/templates/[id]/preview/route");
let apply: typeof import("../../src/app/api/templates/[id]/apply/route");
let db: typeof import("../../src/db/client").db;

before(async () => {
  await migrate();
  repos = await import("../../src/db/repositories");
  collection = await import("../../src/app/api/templates/route");
  item = await import("../../src/app/api/templates/[id]/route");
  preview = await import("../../src/app/api/templates/[id]/preview/route");
  apply = await import("../../src/app/api/templates/[id]/apply/route");
  ({ db } = await import("../../src/db/client"));
});

after(() => cleanup());

function req(method: string, path: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
async function json(res: Response) {
  const text = await res.text();
  return { status: res.status, cache: res.headers.get("cache-control"), text, body: text ? JSON.parse(text) : null };
}

const TABLES = [
  "projects",
  "milestones",
  "tasks",
  "task_dependencies",
  "task_checklist_item",
  "knowledge_documents",
  "activity_events",
  "project_template_applications",
  "project_templates",
  "project_template_milestones",
  "project_template_tasks",
  "project_template_dependencies",
  "project_template_checklist_items",
  "project_template_documents",
] as const;
function rowCounts(): Record<(typeof TABLES)[number], number> {
  return Object.fromEntries(
    TABLES.map((t) => [t, (db.get<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM ${t}`)) ?? { n: 0 }).n]),
  ) as Record<(typeof TABLES)[number], number>;
}

async function createTemplate(body: unknown = FULL_TEMPLATE): Promise<string> {
  const r = await json(await collection.POST(req("POST", "/api/templates", body)));
  assert.equal(r.status, 201, r.text);
  return r.body.template.id as string;
}

async function applyTemplate(id: string, body: Record<string, unknown>) {
  return json(await apply.POST(req("POST", `/api/templates/${id}/apply`, body), ctx(id)));
}

/** Reads a created project back into the database-independent shape. */
async function describeProject(projectId: string): Promise<CreatedProjectShape> {
  const project = (await repos.projectRepository.findById(LOCAL_WORKSPACE_ID, projectId))!;
  const ms = await repos.milestoneRepository.list(LOCAL_WORKSPACE_ID, projectId);
  const ts = await repos.taskRepository.list(LOCAL_WORKSPACE_ID, projectId);
  const titleOfTask = new Map(ts.map((t) => [t.id, t.title]));
  const titleOfMilestone = new Map(ms.map((m) => [m.id, m.title]));
  const deps = db.all<{ task_id: string; depends_on_task_id: string }>(
    sql`SELECT task_id, depends_on_task_id FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ${projectId})`,
  );
  const checklist = db.all<{ task_id: string; position: number; text: string; done: number }>(
    sql`SELECT task_id, position, text, done FROM task_checklist_item WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ${projectId})`,
  );
  const docs = await repos.knowledgeDocumentRepository.list(LOCAL_WORKSPACE_ID, projectId);
  return {
    project: { name: project.name, description: project.description, type: project.type, status: project.status, source: project.source },
    milestones: ms.map((m) => ({ title: m.title, status: m.status, dueDate: m.dueDate })),
    tasks: ts.map((t) => ({
      title: t.title,
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate,
      milestone: t.milestoneId ? titleOfMilestone.get(t.milestoneId)! : null,
      parent: t.parentTaskId ? titleOfTask.get(t.parentTaskId)! : null,
      assigneeId: t.assigneeId,
    })),
    dependencies: deps.map((d) => `${titleOfTask.get(d.task_id)}>${titleOfTask.get(d.depends_on_task_id)}`),
    checklist: checklist
      .map((c) => `${titleOfTask.get(c.task_id)}#${c.position}:${c.text}:${c.done ? "done" : "open"}`)
      .sort(),
    documents: docs.map((d) => ({ title: d.title, category: d.category, pinned: d.pinned })),
    blocked: ts.filter((t) => t.blocked).map((t) => t.title),
  };
}

describe("desktop templates: CRUD and validation", () => {
  it("creates an empty template from a name, saves the full document, and reads it back exactly", async () => {
    const created = await json(await collection.POST(req("POST", "/api/templates", { name: "Blank" })));
    assert.equal(created.status, 201);
    assert.equal(created.cache, "no-store");
    const id = created.body.template.id as string;
    assert.deepEqual(created.body.template.tasks, []);

    const saved = await json(await item.PUT(req("PUT", `/api/templates/${id}`, FULL_TEMPLATE), ctx(id)));
    assert.equal(saved.status, 200, saved.text);
    const read = await json(await item.GET(req("GET", `/api/templates/${id}`), ctx(id)));
    const { id: _id, createdAt: _c, updatedAt: _u, dependencies, ...content } = read.body.template;
    const { dependencies: expectedDeps, ...expected } = JSON.parse(JSON.stringify(FULL_TEMPLATE));
    assert.deepEqual(content, expected, "everything else round-trips in stored order");
    // Dependencies are a set; they are returned in a fixed (taskKey, dependsOnKey) order.
    const edge = (d: { taskKey: string; dependsOnKey: string }) => `${d.taskKey}>${d.dependsOnKey}`;
    assert.deepEqual(dependencies.map(edge), expectedDeps.map(edge).sort());
    assert.equal(read.body.canEdit, true);

    const list = await json(await collection.GET(req("GET", "/api/templates")));
    const summary = list.body.templates.find((t: { id: string }) => t.id === id);
    assert.deepEqual(summary.counts, { milestones: 2, tasks: 5, dependencies: 2, checklist: 3, documents: 2 });
  });

  it("rejects invalid documents and requests with 400, and malformed ids with the generic 404", async () => {
    const id = await createTemplate();
    const cycle = { ...FULL_TEMPLATE, dependencies: [...FULL_TEMPLATE.dependencies, { taskKey: "spec", dependsOnKey: "announce" }] };
    const bad = [
      { ...FULL_TEMPLATE, workspaceId: "ws_other" },
      cycle,
      { ...FULL_TEMPLATE, tasks: [...FULL_TEMPLATE.tasks, { key: "x", title: "X", parentKey: "spec-review" }] },
      { ...FULL_TEMPLATE, checklist: [{ taskKey: "tsk_live_id", text: "x" }] },
      { ...FULL_TEMPLATE, milestones: [{ key: "m", title: "M", targetOffset: -3 }] },
    ];
    for (const body of bad) {
      const r = await json(await item.PUT(req("PUT", `/api/templates/${id}`, body), ctx(id)));
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 120));
      assert.ok(Array.isArray(r.body.issues) && r.body.issues.length > 0);
      assert.ok(!/SQLITE|constraint|sql/i.test(r.text), "no database error text");
    }
    assert.equal((await json(await collection.GET(req("GET", "/api/templates?x=1")))).status, 400);
    const notJson = await item.PUT(new NextRequest(`http://localhost/api/templates/${id}`, { method: "PUT", body: "{nope" }), ctx(id));
    assert.equal(notJson.status, 400);
    for (const bogus of ["tpl_missing", "bad id", "..%2F"]) {
      const r = await json(await item.GET(req("GET", `/api/templates/${encodeURIComponent(bogus)}`), ctx(bogus)));
      assert.equal(r.status, 404);
      assert.equal(r.text, '{"error":"Template not found"}');
    }
  });

  it("deletes a template with all its own rows", async () => {
    const id = await createTemplate();
    const before = rowCounts();
    assert.equal((await json(await item.DELETE(req("DELETE", `/api/templates/${id}`), ctx(id)))).status, 200);
    const afterDelete = rowCounts();
    assert.equal(afterDelete.project_templates, before.project_templates - 1);
    assert.equal(afterDelete.project_template_tasks, before.project_template_tasks - 5);
    assert.equal(afterDelete.project_template_checklist_items, before.project_template_checklist_items - 3);
    assert.equal(afterDelete.project_template_dependencies, before.project_template_dependencies - 2);
    assert.equal(afterDelete.project_template_documents, before.project_template_documents - 2);
    assert.equal(afterDelete.project_template_milestones, before.project_template_milestones - 2);
    assert.equal((await json(await item.DELETE(req("DELETE", `/api/templates/${id}`), ctx(id)))).status, 404);
  });
});

describe("desktop templates: preview", () => {
  it("computes dates, hierarchy, dependencies and counts, and writes nothing", async () => {
    const id = await createTemplate();
    const before = rowCounts();
    const r = await json(await preview.GET(req("GET", `/api/templates/${id}/preview?startDate=${FIXTURE_START}&name=Custom+name`), ctx(id)));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.cache, "no-store");
    assert.deepEqual(rowCounts(), before, "preview created or changed nothing");
    const p = r.body.preview;
    assert.equal(p.projectName, "Custom name");
    assert.deepEqual(p.milestones.map((m: { targetDate: string }) => m.targetDate), ["2028-03-12", "2028-03-28"]);
    assert.equal(p.tasks.find((t: { key: string }) => t.key === "spec").dueDate, "2028-02-29");
    assert.deepEqual(p.counts, { milestones: 2, tasks: 5, subtasks: 1, dependencies: 2, checklist: 3, documents: 2, records: 17 });
    assert.deepEqual(p.errors, []);
  });

  it("rejects bad parameters and reports dates beyond the calendar as errors", async () => {
    const id = await createTemplate();
    for (const q of ["", "startDate=2028-02-30", "startDate=02/27/2028", "startDate=2028-02-27&startDate=2028-02-28", "startDate=2028-02-27&workspaceId=x"]) {
      assert.equal((await preview.GET(req("GET", `/api/templates/${id}/preview?${q}`), ctx(id))).status, 400, q);
    }
    const late = await json(await preview.GET(req("GET", `/api/templates/${id}/preview?startDate=9999-12-20`), ctx(id)));
    assert.equal(late.status, 200);
    assert.ok(late.body.preview.errors.length > 0);
  });
});

describe("desktop templates: application", () => {
  it("creates the complete project, identifiable as template-created", async () => {
    const id = await createTemplate();
    const r = await applyTemplate(id, { idempotencyKey: requestKey("full"), startDate: FIXTURE_START });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.created, true);
    assert.deepEqual(Object.keys(r.body.tasks).sort(), ["announce", "build", "retro", "spec", "spec-review"]);
    assertCreatedProject(await describeProject(r.body.project.id));
    const event = db.get<{ type: string; metadata: string }>(
      sql`SELECT type, metadata FROM activity_events WHERE project_id = ${r.body.project.id}`,
    )!;
    assert.equal(event.type, "project.created");
    assert.deepEqual(JSON.parse(event.metadata), { source: "template", templateId: id, templateName: "Launch template" });
    assert.ok(!event.metadata.includes(requestKey("full")), "the request key is never exposed");
  });

  it("replays the same key and request, and conflicts on a different request with the same key", async () => {
    const id = await createTemplate();
    const key = requestKey("retry");
    const first = await applyTemplate(id, { idempotencyKey: key, startDate: FIXTURE_START });
    assert.equal(first.status, 201);
    const before = rowCounts();
    const again = await applyTemplate(id, { idempotencyKey: key, startDate: FIXTURE_START });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { created: false, project: first.body.project });
    assert.deepEqual(rowCounts(), before, "a replay creates nothing");
    for (const different of [
      { idempotencyKey: key, startDate: "2028-03-01" },
      { idempotencyKey: key, startDate: FIXTURE_START, name: "Other name" },
    ]) {
      const r = await applyTemplate(id, different);
      assert.equal(r.status, 409);
      assert.equal(r.body.error, "This request key was already used for a different request.");
    }
    const otherTemplate = await createTemplate();
    assert.equal((await applyTemplate(otherTemplate, { idempotencyKey: key, startDate: FIXTURE_START })).status, 409);
    assert.deepEqual(rowCounts().projects, before.projects);
  });

  for (const point of ["application", "project", "milestones", "tasks", "dependencies", "checklist", "documents", "activity"] as ApplyFailurePoint[]) {
    it(`rolls back everything when a failure is injected after "${point}", and the key stays usable`, async () => {
      const id = await createTemplate();
      const key = requestKey(`fail-${point}`);
      const before = rowCounts();
      await assert.rejects(
        repos.templateRepository.apply(
          LOCAL_WORKSPACE_ID,
          id,
          { idempotencyKey: key, startDate: FIXTURE_START, requestHash: "h" },
          { userId: null, actorKey: "local" },
          point,
        ),
        /Injected failure/,
      );
      assert.deepEqual(rowCounts(), before, "no partial project, child rows or application record");
      const retry = await applyTemplate(id, { idempotencyKey: key, startDate: FIXTURE_START });
      assert.equal(retry.status, 201, "a failed attempt never consumes its key");
    });
  }

  it("refuses a start date whose calculated dates leave the calendar, writing nothing", async () => {
    const id = await createTemplate();
    const before = rowCounts();
    const r = await applyTemplate(id, { idempotencyKey: requestKey("late"), startDate: "9999-12-20" });
    assert.equal(r.status, 422);
    assert.ok(r.body.issues.length > 0);
    assert.deepEqual(rowCounts(), before);
  });

  it("validates requests and answers unknown templates with the generic 404", async () => {
    const id = await createTemplate();
    for (const body of [
      { startDate: FIXTURE_START },
      { idempotencyKey: "short", startDate: FIXTURE_START },
      { idempotencyKey: requestKey("v"), startDate: "2028-13-01" },
      { idempotencyKey: requestKey("v"), startDate: FIXTURE_START, workspaceId: "ws" },
    ]) {
      assert.equal((await applyTemplate(id, body)).status, 400, JSON.stringify(body));
    }
    const missing = await applyTemplate("tpl_missing", { idempotencyKey: requestKey("m"), startDate: FIXTURE_START });
    assert.equal(missing.status, 404);
    assert.equal(missing.text, '{"error":"Template not found"}');
  });
});

describe("desktop templates: deletion and limits", () => {
  it("deleting a template leaves created projects intact, and a retry still returns them", async () => {
    const id = await createTemplate();
    const key = requestKey("keep");
    const created = await applyTemplate(id, { idempotencyKey: key, startDate: FIXTURE_START });
    assert.equal((await json(await item.DELETE(req("DELETE", `/api/templates/${id}`), ctx(id)))).status, 200);
    assertCreatedProject(await describeProject(created.body.project.id));
    const row = db.get<{ template_id: string | null }>(sql`SELECT template_id FROM project_template_applications WHERE idempotency_key = ${key}`)!;
    assert.equal(row.template_id, null);
    const retry = await applyTemplate(id, { idempotencyKey: key, startDate: FIXTURE_START });
    assert.equal(retry.status, 200, "the retry answers from the application record, not the deleted template");
    assert.deepEqual(retry.body, { created: false, project: created.body.project });
  });

  it("a retry after the created project was deleted is a conflict, not a silent re-create", async () => {
    const id = await createTemplate();
    const key = requestKey("gone");
    const created = await applyTemplate(id, { idempotencyKey: key, startDate: FIXTURE_START });
    await repos.projectRepository.delete(LOCAL_WORKSPACE_ID, created.body.project.id);
    const r = await applyTemplate(id, { idempotencyKey: key, startDate: FIXTURE_START });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "The project this request created has since been deleted.");
  });

  it("caps the number of templates", async () => {
    const { MAX_TEMPLATES_PER_WORKSPACE } = await import("../../src/core/templates/limits");
    const existing = rowCounts().project_templates;
    for (let i = existing; i < MAX_TEMPLATES_PER_WORKSPACE; i++) {
      assert.equal((await repos.templateRepository.create(LOCAL_WORKSPACE_ID, { ...FULL_TEMPLATE, name: `T${i}`, tasks: [], dependencies: [], checklist: [] } as never, null)).kind, "created");
    }
    const r = await json(await collection.POST(req("POST", "/api/templates", { name: "One too many" })));
    assert.equal(r.status, 409);
    assert.equal(rowCounts().project_templates, MAX_TEMPLATES_PER_WORKSPACE);
  });
});

describe("desktop templates: upgrade from the pre-template schema", () => {
  it("applies migration 0010 on a populated pre-template database without touching existing rows", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const Database = (await import("better-sqlite3")).default;
    const dir = path.resolve(process.cwd(), "drizzle");
    const journal = JSON.parse(fs.readFileSync(path.join(dir, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    const templateMigration = journal.entries.find((e) => e.tag.endsWith("_reusable_templates"))!;
    const legacy = new Database(":memory:");
    legacy.pragma("foreign_keys = ON");
    const run = (tag: string) => {
      for (const chunk of fs.readFileSync(path.join(dir, `${tag}.sql`), "utf8").split("--> statement-breakpoint")) {
        if (chunk.trim()) legacy.exec(chunk);
      }
    };
    try {
      for (const e of journal.entries.filter((e) => e.idx < templateMigration.idx)) run(e.tag);
      legacy.exec(`INSERT INTO projects (id, name) VALUES ('p1', 'Existing project')`);
      legacy.exec(`INSERT INTO tasks (id, project_id, title) VALUES ('t1', 'p1', 'Existing task')`);
      run(templateMigration.tag);
      assert.equal((legacy.prepare(`SELECT name FROM projects WHERE id = 'p1'`).get() as { name: string }).name, "Existing project");
      assert.equal((legacy.prepare(`SELECT count(*) AS n FROM tasks`).get() as { n: number }).n, 1);
      const tables = legacy.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'project_template%'`).get() as { n: number };
      assert.equal(tables.n, 7);
      legacy.exec(`INSERT INTO project_templates (id, name, project_name) VALUES ('t1', 'T', 'P')`);
      legacy.exec(`INSERT INTO project_template_tasks (id, template_id, key, position, title) VALUES ('x', 't1', 'a', 0, 'A')`);
      // Composite foreign keys hold on desktop too: a key only resolves within its own template.
      assert.throws(() =>
        legacy.exec(`INSERT INTO project_template_tasks (id, template_id, key, position, title, parent_key) VALUES ('y', 't1', 'b', 1, 'B', 'nope')`),
      /FOREIGN KEY/);
    } finally {
      legacy.close();
    }
  });
});

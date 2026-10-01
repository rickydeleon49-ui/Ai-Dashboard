/**
 * Release 2D.3 templates — accounts-mode API authorization (Auth.js + PostgreSQL).
 * Real magic-link sessions, real route handlers, no overrides.
 *
 * 1. Unauthenticated → 401 everywhere; suspended / removed → 403 everywhere.
 * 2. Every active role reads and previews; owner, admin and member create,
 *    edit, delete and apply; the viewer gets 403 for each of those.
 * 3. Foreign template ids and forged workspace cookies read as not found;
 *    client-supplied workspace fields are rejected; the project lands in the
 *    caller's workspace only.
 * 4. Idempotent application over HTTP, including simultaneous requests.
 * 5. No emails, roles or other-workspace data in any response.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db.pg";
import { FIXTURE_START, FULL_TEMPLATE, requestKey } from "../helpers/template-fixtures";

process.env.AUTH_SECRET = "test-secret-for-automated-tests-only-not-real";
process.env.AUTH_MODE = "accounts";

let collection: typeof import("../../src/app/api/templates/route");
let item: typeof import("../../src/app/api/templates/[id]/route");
let preview: typeof import("../../src/app/api/templates/[id]/preview/route");
let apply: typeof import("../../src/app/api/templates/[id]/apply/route");
let handlers: typeof import("../../src/auth").handlers;
let NextRequest: typeof import("next/server").NextRequest;
let db: typeof import("../../src/db/pg-client").getPgDb;
let schema: typeof import("../../src/db/schema.pg");

const EMAILS = {
  owner: "tpl_owner@example.com",
  admin: "tpl_admin@example.com",
  member: "tpl_member@example.com",
  viewer: "tpl_viewer@example.com",
  suspended: "tpl_suspended@example.com",
  removed: "tpl_removed@example.com",
  outsider: "tpl_outsider@example.com",
} as const;
type Role = keyof typeof EMAILS;
const session = {} as Record<Role, string>;
const id = {} as Record<Role, string>;
let wsA: string;
let wsB: string;
let templateA: string;
let templateB: string;

function cookie(role: Role, ws = role === "outsider" ? wsB : wsA) {
  return `${session[role]}; cc-current-workspace=${ws}`;
}

function req(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      host: "localhost",
      "x-forwarded-proto": "http",
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

async function signIn(email: string): Promise<string> {
  const jar = new Map<string, string>();
  const header = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const absorb = (r: Response) => {
    for (const raw of r.headers.getSetCookie()) {
      const pair = raw.split(";")[0] ?? "";
      const i = pair.indexOf("=");
      const v = pair.slice(i + 1);
      if (v === "") jar.delete(pair.slice(0, i));
      else jar.set(pair.slice(0, i), v);
    }
  };
  const csrf = await handlers.GET(new NextRequest("http://localhost/api/auth/csrf"));
  absorb(csrf);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const logs: string[] = [];
  const original = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  let signin: Response;
  try {
    signin = await handlers.POST(
      new NextRequest("http://localhost/api/auth/signin/nodemailer", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: header() },
        body: new URLSearchParams({ email, csrfToken, callbackUrl: "http://localhost/" }).toString(),
      }),
    );
  } finally {
    console.log = original;
  }
  absorb(signin);
  const link = logs.find((l) => l.includes(`magic link for ${email}`))?.match(/(http:\S+)/)?.[1];
  if (!link) throw new Error(`no magic link for ${email}`);
  const cb = await handlers.GET(new NextRequest(link, { headers: { cookie: header() } }));
  absorb(cb);
  assert.equal(cb.status, 302);
  return header();
}

const ctx = (templateId: string) => ({ params: Promise.resolve({ id: templateId }) });
async function send(res: Response) {
  const text = await res.text();
  return { status: res.status, text, cache: res.headers.get("cache-control"), body: text ? JSON.parse(text) : null };
}

const calls = {
  list: (c?: string) => collection.GET(req("GET", "/api/templates", { cookie: c })),
  create: (c: string | undefined, body: unknown = { name: "Role template" }) => collection.POST(req("POST", "/api/templates", { cookie: c, body })),
  get: (c: string | undefined, t: string) => item.GET(req("GET", `/api/templates/${t}`, { cookie: c }), ctx(t)),
  put: (c: string | undefined, t: string, body: unknown = FULL_TEMPLATE) => item.PUT(req("PUT", `/api/templates/${t}`, { cookie: c, body }), ctx(t)),
  del: (c: string | undefined, t: string) => item.DELETE(req("DELETE", `/api/templates/${t}`, { cookie: c }), ctx(t)),
  preview: (c: string | undefined, t: string, q = `startDate=${FIXTURE_START}`) => preview.GET(req("GET", `/api/templates/${t}/preview?${q}`, { cookie: c }), ctx(t)),
  apply: (c: string | undefined, t: string, body: unknown) => apply.POST(req("POST", `/api/templates/${t}/apply`, { cookie: c, body }), ctx(t)),
};

before(async () => {
  await migrate();
  collection = await import("../../src/app/api/templates/route");
  item = await import("../../src/app/api/templates/[id]/route");
  preview = await import("../../src/app/api/templates/[id]/preview/route");
  apply = await import("../../src/app/api/templates/[id]/apply/route");
  ({ handlers } = await import("../../src/auth"));
  ({ NextRequest } = await import("next/server"));
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  schema = await import("../../src/db/schema.pg");
  const workspaces = await import("../../src/core/workspaces/service");

  for (const role of Object.keys(EMAILS) as Role[]) session[role] = await signIn(EMAILS[role]);
  const users = await db().select().from(schema.users);
  for (const role of Object.keys(EMAILS) as Role[]) {
    id[role] = users.find((u) => u.email === EMAILS[role])!.id;
    await db().update(schema.users).set({ name: `TPL ${role}` }).where(eq(schema.users.id, id[role]));
  }
  wsA = (await workspaces.createTeamWorkspace(id.owner, "Templates WS A")).id;
  wsB = (await workspaces.createTeamWorkspace(id.outsider, "Templates WS B")).id;
  await db().insert(schema.workspaceMembers).values([
    { workspaceId: wsA, userId: id.admin, role: "admin", status: "active" },
    { workspaceId: wsA, userId: id.member, role: "member", status: "active" },
    { workspaceId: wsA, userId: id.viewer, role: "viewer", status: "active" },
    { workspaceId: wsA, userId: id.suspended, role: "member", status: "suspended" },
    { workspaceId: wsA, userId: id.removed, role: "member", status: "removed" },
    { workspaceId: wsB, userId: id.member, role: "member", status: "active" },
  ]);
  const a = await send(await calls.create(cookie("owner"), FULL_TEMPLATE));
  assert.equal(a.status, 201, a.text);
  templateA = a.body.template.id;
  const b = await send(await calls.create(cookie("outsider"), { ...FULL_TEMPLATE, name: "B secret template" }));
  templateB = b.body.template.id;
});

after(() => cleanup());

describe("Release 2D.3 templates API — authentication and roles", () => {
  it("unauthenticated requests get 401 on every endpoint, no-store", async () => {
    for (const res of [
      await calls.list(),
      await calls.create(undefined),
      await calls.get(undefined, templateA),
      await calls.put(undefined, templateA),
      await calls.del(undefined, templateA),
      await calls.preview(undefined, templateA),
      await calls.apply(undefined, templateA, { idempotencyKey: requestKey("anon"), startDate: FIXTURE_START }),
    ]) {
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
  });

  for (const role of ["suspended", "removed"] as const) {
    it(`${role} members naming the workspace get 403 on every endpoint`, async () => {
      for (const res of [
        await calls.list(cookie(role)),
        await calls.create(cookie(role)),
        await calls.get(cookie(role), templateA),
        await calls.put(cookie(role), templateA),
        await calls.del(cookie(role), templateA),
        await calls.preview(cookie(role), templateA),
        await calls.apply(cookie(role), templateA, { idempotencyKey: requestKey(role), startDate: FIXTURE_START }),
      ]) {
        assert.equal(res.status, 403);
      }
    });
  }

  for (const role of ["owner", "admin", "member", "viewer"] as const) {
    it(`${role} reads, lists and previews`, async () => {
      const list = await send(await calls.list(cookie(role)));
      assert.equal(list.status, 200);
      assert.equal(list.body.canEdit, role !== "viewer");
      assert.ok(list.body.templates.some((t: { id: string }) => t.id === templateA));
      assert.equal((await calls.get(cookie(role), templateA)).status, 200);
      const p = await send(await calls.preview(cookie(role), templateA));
      assert.equal(p.status, 200);
      assert.equal(p.body.canApply, role !== "viewer");
      for (const text of [list.text, p.text]) assert.ok(!text.includes("@example.com") && !/"role"/.test(text));
    });
  }

  for (const role of ["owner", "admin", "member"] as const) {
    it(`${role} creates, edits, applies and deletes`, async () => {
      const created = await send(await calls.create(cookie(role), { ...FULL_TEMPLATE, name: `${role} template` }));
      assert.equal(created.status, 201);
      const t = created.body.template.id as string;
      assert.equal((await calls.put(cookie(role), t, { ...FULL_TEMPLATE, name: `${role} renamed` })).status, 200);
      const applied = await send(await calls.apply(cookie(role), t, { idempotencyKey: requestKey(`role-${role}`), startDate: FIXTURE_START }));
      assert.equal(applied.status, 201, applied.text);
      const [project] = await db().select({ workspaceId: schema.projects.workspaceId }).from(schema.projects).where(eq(schema.projects.id, applied.body.project.id));
      assert.equal(project!.workspaceId, wsA, "created in the caller's workspace");
      assert.equal((await calls.del(cookie(role), t)).status, 200);
    });
  }

  it("viewer cannot create, edit, delete or apply", async () => {
    const before = await db().select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.workspaceId, wsA));
    assert.equal((await calls.create(cookie("viewer"))).status, 403);
    assert.equal((await calls.put(cookie("viewer"), templateA)).status, 403);
    assert.equal((await calls.del(cookie("viewer"), templateA)).status, 403);
    assert.equal((await calls.apply(cookie("viewer"), templateA, { idempotencyKey: requestKey("viewer"), startDate: FIXTURE_START })).status, 403);
    const afterRows = await db().select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.workspaceId, wsA));
    assert.equal(afterRows.length, before.length);
    assert.equal((await calls.get(cookie("owner"), templateA)).status, 200, "still there");
  });
});

describe("Release 2D.3 templates API — isolation", () => {
  it("a foreign template id reads exactly like a nonexistent one on every endpoint", async () => {
    const missing = "tpl_does_not_exist";
    for (const [foreign, absent] of [
      [await calls.get(cookie("owner"), templateB), await calls.get(cookie("owner"), missing)],
      [await calls.put(cookie("owner"), templateB), await calls.put(cookie("owner"), missing)],
      [await calls.del(cookie("owner"), templateB), await calls.del(cookie("owner"), missing)],
      [await calls.preview(cookie("owner"), templateB), await calls.preview(cookie("owner"), missing)],
      [
        await calls.apply(cookie("owner"), templateB, { idempotencyKey: requestKey("foreign"), startDate: FIXTURE_START }),
        await calls.apply(cookie("owner"), missing, { idempotencyKey: requestKey("absent"), startDate: FIXTURE_START }),
      ],
    ]) {
      const f = await send(foreign!);
      const a = await send(absent!);
      assert.equal(f.status, 404);
      assert.equal(f.text, a.text);
      assert.equal(f.text, '{"error":"Template not found"}');
    }
    const list = await send(await calls.list(cookie("owner")));
    assert.ok(!list.text.includes("B secret template"));
    assert.ok(await db().select().from(schema.projectTemplates).where(eq(schema.projectTemplates.id, templateB)).then((r) => r.length === 1), "B's template untouched");
  });

  it("a forged workspace cookie resolves to the caller's own workspace", async () => {
    const forged = await send(await calls.list(cookie("outsider", wsA)));
    assert.equal(forged.status, 200);
    assert.notEqual(forged.body.workspaceId, wsA, "one of the outsider's own workspaces, never A");
    assert.ok(!forged.body.templates.some((t: { id: string }) => t.id === templateA));
    assert.equal((await calls.get(cookie("outsider", wsA), templateA)).status, 404);
  });

  it("follows the active-workspace cookie for a member of both workspaces", async () => {
    assert.equal((await calls.get(cookie("member", wsA), templateA)).status, 200);
    assert.equal((await calls.get(cookie("member", wsB), templateA)).status, 404);
    assert.equal((await calls.apply(cookie("member", wsB), templateA, { idempotencyKey: requestKey("switch"), startDate: FIXTURE_START })).status, 404);
  });

  it("rejects client-supplied workspace ids and live record ids in bodies", async () => {
    for (const body of [
      { ...FULL_TEMPLATE, workspaceId: wsB },
      { ...FULL_TEMPLATE, project: { ...FULL_TEMPLATE.project, workspaceId: wsB } },
      { ...FULL_TEMPLATE, tasks: [{ key: "a", title: "A", id: "tsk_live" }] },
      { ...FULL_TEMPLATE, tasks: [{ key: "a", title: "A", assigneeId: id.member }] },
    ]) {
      assert.equal((await calls.put(cookie("owner"), templateA, body)).status, 400);
    }
    assert.equal((await calls.apply(cookie("owner"), templateA, { idempotencyKey: requestKey("ws"), startDate: FIXTURE_START, workspaceId: wsB })).status, 400);
    assert.equal((await calls.list(`${cookie("owner")}`)).status, 200);
    assert.equal((await collection.GET(req("GET", `/api/templates?workspaceId=${wsB}`, { cookie: cookie("owner") }))).status, 400);
  });
});

describe("Release 2D.3 templates API — idempotent application", () => {
  it("replays the same request and conflicts on a different one", async () => {
    const key = requestKey("http-retry");
    const first = await send(await calls.apply(cookie("owner"), templateA, { idempotencyKey: key, startDate: FIXTURE_START }));
    assert.equal(first.status, 201);
    const again = await send(await calls.apply(cookie("owner"), templateA, { idempotencyKey: key, startDate: FIXTURE_START }));
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { created: false, project: first.body.project });
    const different = await send(await calls.apply(cookie("owner"), templateA, { idempotencyKey: key, startDate: "2028-03-01" }));
    assert.equal(different.status, 409);
    assert.ok(!/key-http-retry/.test(first.text + again.text + different.text), "the key is never echoed");
  });

  it("simultaneous HTTP requests with the same key create exactly one project", async () => {
    const key = requestKey("http-race");
    const results = await Promise.all(
      Array.from({ length: 6 }, () => calls.apply(cookie("admin"), templateA, { idempotencyKey: key, startDate: FIXTURE_START }).then(send)),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 201]);
    assert.equal(new Set(results.map((r) => r.body.project.id)).size, 1);
    const apps = await db().select().from(schema.projectTemplateApplications).where(eq(schema.projectTemplateApplications.idempotencyKey, key));
    assert.equal(apps.length, 1);
  });

  it("the same key used by two different people is two separate requests", async () => {
    const key = requestKey("http-two-people");
    const a = await send(await calls.apply(cookie("owner"), templateA, { idempotencyKey: key, startDate: FIXTURE_START }));
    const b = await send(await calls.apply(cookie("member"), templateA, { idempotencyKey: key, startDate: FIXTURE_START }));
    assert.deepEqual([a.status, b.status], [201, 201]);
    assert.notEqual(a.body.project.id, b.body.project.id);
  });
});

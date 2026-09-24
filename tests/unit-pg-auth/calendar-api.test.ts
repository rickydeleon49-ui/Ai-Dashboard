/**
 * Release 2D.1 calendar — accounts-mode API authorization (Auth.js + PostgreSQL).
 * Real magic-link sessions, real route handlers, no overrides.
 *
 * 1. Unauthenticated: every /api/calendar route 401s.
 * 2. Owner / admin / member: read, canReschedule true, and reschedule tasks and
 *    milestones through the existing routes.
 * 3. Viewer: reads with canReschedule false; the existing routes refuse (403).
 * 4. Suspended / removed (cookie naming the workspace): 403.
 * 5. Outsider: sees only their own workspace; workspace A's items never appear.
 * 6. Cross-workspace filter ids (project, assignee) → the same 400 as unknown
 *    ids; cross-workspace record ids on reschedule → 404 and nothing changes.
 * 7. Workspace switching: the response follows the active-workspace cookie.
 * 8. Filter options: active members, id + name only.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db.pg";

process.env.AUTH_SECRET = "test-secret-for-automated-tests-only-not-real";
process.env.AUTH_MODE = "accounts";

let calendarRoute: typeof import("../../src/app/api/calendar/route");
let unscheduledRoute: typeof import("../../src/app/api/calendar/unscheduled/route");
let filtersRoute: typeof import("../../src/app/api/calendar/filters/route");
let searchRoute: typeof import("../../src/app/api/calendar/filters/search/route");
let projectsRoute: typeof import("../../src/app/api/projects/route");
let projectTasksRoute: typeof import("../../src/app/api/projects/[id]/tasks/route");
let milestonesRoute: typeof import("../../src/app/api/projects/[id]/milestones/route");
let milestoneRoute: typeof import("../../src/app/api/projects/[id]/milestones/[milestoneId]/route");
let taskRoute: typeof import("../../src/app/api/tasks/[id]/route");
let handlers: typeof import("../../src/auth").handlers;
let NextRequest: typeof import("next/server").NextRequest;
let db: typeof import("../../src/db/pg-client").getPgDb;
let schema: typeof import("../../src/db/schema.pg");

const EMAILS = {
  owner: "cal_owner@example.com",
  admin: "cal_admin@example.com",
  member: "cal_member@example.com",
  viewer: "cal_viewer@example.com",
  suspended: "cal_suspended@example.com",
  removed: "cal_removed@example.com",
  outsider: "cal_outsider@example.com",
} as const;
type Role = keyof typeof EMAILS;
const session = {} as Record<Role, string>;
const id = {} as Record<Role, string>;
let wsA: string;
let wsB: string;
let projectA: string;
let projectB: string;
let taskA: string;
let milestoneA: string;
let taskB: string;
let milestoneB: string;

const RANGE = "from=2026-09-28&to=2026-11-08";

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

interface RangeBody {
  workspaceId: string;
  items: { kind: string; id: string; title: string; date: string }[];
  canReschedule: boolean;
}

async function range(c: string | undefined, query = RANGE) {
  const res = await calendarRoute.GET(req("GET", `/api/calendar?${query}`, { cookie: c }));
  return { res, body: res.status === 200 ? ((await res.json()) as RangeBody) : null };
}

async function patchTask(c: string, taskId: string, dueDate: string) {
  return taskRoute.PATCH(req("PATCH", `/api/tasks/${taskId}`, { cookie: c, body: { dueDate } }), {
    params: Promise.resolve({ id: taskId }),
  });
}

async function patchMilestone(c: string, projectId: string, milestoneId: string, dueDate: string) {
  return milestoneRoute.PATCH(
    req("PATCH", `/api/projects/${projectId}/milestones/${milestoneId}`, { cookie: c, body: { dueDate } }),
    { params: Promise.resolve({ id: projectId, milestoneId }) },
  );
}

async function dueOf(taskId: string) {
  const [row] = await db().select({ d: schema.tasks.dueDate }).from(schema.tasks).where(eq(schema.tasks.id, taskId));
  return row?.d?.toISOString().slice(0, 10) ?? null;
}

before(async () => {
  await migrate();
  calendarRoute = await import("../../src/app/api/calendar/route");
  unscheduledRoute = await import("../../src/app/api/calendar/unscheduled/route");
  filtersRoute = await import("../../src/app/api/calendar/filters/route");
  searchRoute = await import("../../src/app/api/calendar/filters/search/route");
  projectsRoute = await import("../../src/app/api/projects/route");
  projectTasksRoute = await import("../../src/app/api/projects/[id]/tasks/route");
  milestonesRoute = await import("../../src/app/api/projects/[id]/milestones/route");
  milestoneRoute = await import("../../src/app/api/projects/[id]/milestones/[milestoneId]/route");
  taskRoute = await import("../../src/app/api/tasks/[id]/route");
  ({ handlers } = await import("../../src/auth"));
  ({ NextRequest } = await import("next/server"));
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  schema = await import("../../src/db/schema.pg");
  const workspaces = await import("../../src/core/workspaces/service");

  for (const role of Object.keys(EMAILS) as Role[]) session[role] = await signIn(EMAILS[role]);
  const users = await db().select().from(schema.users);
  for (const role of Object.keys(EMAILS) as Role[]) {
    id[role] = users.find((u) => u.email === EMAILS[role])!.id;
    await db().update(schema.users).set({ name: `Cal ${role}` }).where(eq(schema.users.id, id[role]));
  }
  wsA = (await workspaces.createTeamWorkspace(id.owner, "Calendar WS A")).id;
  wsB = (await workspaces.createTeamWorkspace(id.outsider, "Calendar WS B")).id;
  await db().insert(schema.workspaceMembers).values([
    { workspaceId: wsA, userId: id.admin, role: "admin", status: "active" },
    { workspaceId: wsA, userId: id.member, role: "member", status: "active" },
    { workspaceId: wsA, userId: id.viewer, role: "viewer", status: "active" },
    { workspaceId: wsA, userId: id.suspended, role: "member", status: "suspended" },
    { workspaceId: wsA, userId: id.removed, role: "member", status: "removed" },
    { workspaceId: wsB, userId: id.member, role: "member", status: "active" },
  ]);

  const mkProject = async (c: string, name: string) =>
    ((await (await projectsRoute.POST(req("POST", "/api/projects", { cookie: c, body: { name } }))).json()) as {
      project: { id: string };
    }).project.id;
  const mkTask = async (c: string, projectId: string, body: Record<string, unknown>) => {
    const res = await projectTasksRoute.POST(req("POST", `/api/projects/${projectId}/tasks`, { cookie: c, body }), {
      params: Promise.resolve({ id: projectId }),
    });
    assert.equal(res.status, 201);
    return ((await res.json()) as { task: { id: string } }).task.id;
  };
  const mkMilestone = async (c: string, projectId: string, body: Record<string, unknown>) => {
    const res = await milestonesRoute.POST(req("POST", `/api/projects/${projectId}/milestones`, { cookie: c, body }), {
      params: Promise.resolve({ id: projectId }),
    });
    assert.equal(res.status, 201);
    return ((await res.json()) as { milestone: { id: string } }).milestone.id;
  };

  projectA = await mkProject(cookie("owner"), "Calendar Project A");
  projectB = await mkProject(cookie("outsider"), "Calendar Project B secret");
  taskA = await mkTask(cookie("owner"), projectA, { title: "A task Oct 1", dueDate: "2026-10-01", assigneeId: id.member });
  milestoneA = await mkMilestone(cookie("owner"), projectA, { title: "A milestone Oct 15", dueDate: "2026-10-15" });
  await mkTask(cookie("owner"), projectA, { title: "A undated" });
  taskB = await mkTask(cookie("outsider"), projectB, { title: "B secret task Oct 1", dueDate: "2026-10-01" });
  milestoneB = await mkMilestone(cookie("outsider"), projectB, { title: "B secret milestone", dueDate: "2026-10-15" });
});

after(() => cleanup());

describe("Release 2D.1 calendar API — authentication and roles", () => {
  it("unauthenticated requests get 401 on every calendar route", async () => {
    for (const res of [
      await calendarRoute.GET(req("GET", `/api/calendar?${RANGE}`)),
      await unscheduledRoute.GET(req("GET", "/api/calendar/unscheduled")),
      await filtersRoute.GET(req("GET", "/api/calendar/filters")),
    ]) {
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
  });

  for (const role of ["owner", "admin", "member"] as const) {
    it(`${role}: reads the workspace calendar and can reschedule tasks and milestones`, async () => {
      const { res, body } = await range(cookie(role));
      assert.equal(res.status, 200);
      assert.equal(body!.workspaceId, wsA);
      assert.equal(body!.canReschedule, true);
      assert.deepEqual(body!.items.map((i) => `${i.date} ${i.title}`), ["2026-10-01 A task Oct 1", "2026-10-15 A milestone Oct 15"]);

      assert.equal((await patchTask(cookie(role), taskA, "2026-10-03")).status, 200);
      assert.equal((await patchMilestone(cookie(role), projectA, milestoneA, "2026-10-16")).status, 200);
      const after = (await range(cookie(role))).body!;
      assert.equal(after.items.find((i) => i.id === taskA)?.date, "2026-10-03");
      assert.equal(after.items.find((i) => i.id === milestoneA)?.date, "2026-10-16");
      // Restore for the next role.
      await patchTask(cookie("owner"), taskA, "2026-10-01");
      await patchMilestone(cookie("owner"), projectA, milestoneA, "2026-10-15");
    });
  }

  it("viewer: reads with canReschedule false; the existing routes refuse to reschedule", async () => {
    const { res, body } = await range(cookie("viewer"));
    assert.equal(res.status, 200);
    assert.equal(body!.canReschedule, false);
    assert.equal(body!.items.length, 2);
    assert.equal((await patchTask(cookie("viewer"), taskA, "2026-10-09")).status, 403);
    assert.equal((await patchMilestone(cookie("viewer"), projectA, milestoneA, "2026-10-09")).status, 403);
    assert.equal(await dueOf(taskA), "2026-10-01", "nothing changed");
    const filters = await filtersRoute.GET(req("GET", "/api/calendar/filters", { cookie: cookie("viewer") }));
    assert.equal(((await filters.json()) as { canReschedule: boolean }).canReschedule, false);
  });

  for (const role of ["suspended", "removed"] as const) {
    it(`${role} member: 403 on every calendar route`, async () => {
      for (const res of [
        (await range(cookie(role))).res,
        await unscheduledRoute.GET(req("GET", "/api/calendar/unscheduled", { cookie: cookie(role) })),
        await filtersRoute.GET(req("GET", "/api/calendar/filters", { cookie: cookie(role) })),
      ]) {
        assert.equal(res.status, 403);
      }
    });
  }

  it("outsider: only their own workspace, even when forging workspace A in the cookie", async () => {
    for (const c of [cookie("outsider"), cookie("outsider", wsA)]) {
      const { res, body } = await range(c);
      assert.equal(res.status, 200);
      assert.notEqual(body!.workspaceId, wsA);
      assert.ok(!body!.items.some((i) => i.title.startsWith("A ")));
    }
  });
});

describe("Release 2D.1 calendar API — cross-workspace ids and switching", () => {
  it("foreign and unknown filter ids get the identical 400", async () => {
    const queries = [
      `${RANGE}&projectId=${projectB}`,
      `${RANGE}&projectId=prj_never_existed`,
      `${RANGE}&assignee=${id.outsider}`,
      `${RANGE}&assignee=00000000-0000-4000-8000-000000000000`,
    ];
    const bodies = [];
    for (const q of queries) {
      const { res } = await range(cookie("member"), q);
      assert.equal(res.status, 400, q);
      bodies.push(await res.json());
    }
    for (const b of bodies) assert.deepEqual(b, { error: "Unknown filter value." });
    const un = await unscheduledRoute.GET(req("GET", `/api/calendar/unscheduled?projectId=${projectB}`, { cookie: cookie("member") }));
    assert.equal(un.status, 400);
  });

  it("valid in-workspace filters work, including assignee = me / a member / unassigned", async () => {
    const mine = (await range(cookie("member"), `${RANGE}&assignee=me`)).body!;
    assert.deepEqual(mine.items.map((i) => i.title), ["A task Oct 1"]);
    const byId = (await range(cookie("owner"), `${RANGE}&assignee=${id.member}`)).body!;
    assert.deepEqual(byId.items.map((i) => i.title), ["A task Oct 1"]);
    const unassigned = (await range(cookie("owner"), `${RANGE}&assignee=unassigned`)).body!;
    assert.deepEqual(unassigned.items, [], "milestones are excluded by any assignee filter");
    const project = (await range(cookie("owner"), `${RANGE}&projectId=${projectA}&kind=milestones`)).body!;
    assert.deepEqual(project.items.map((i) => i.title), ["A milestone Oct 15"]);
  });

  it("rescheduling a foreign task or milestone is a 404 and changes nothing", async () => {
    assert.equal((await patchTask(cookie("owner"), taskB, "2026-10-20")).status, 404);
    assert.equal((await patchMilestone(cookie("owner"), projectB, milestoneB, "2026-10-20")).status, 404);
    assert.equal((await patchMilestone(cookie("owner"), projectA, milestoneB, "2026-10-20")).status, 404);
    assert.equal(await dueOf(taskB), "2026-10-01");
    const [m] = await db()
      .select({ d: schema.milestones.dueDate })
      .from(schema.milestones)
      .where(and(eq(schema.milestones.id, milestoneB)));
    assert.equal(m?.d?.toISOString().slice(0, 10), "2026-10-15");
  });

  it("the calendar follows the active-workspace cookie when switching", async () => {
    const inA = (await range(cookie("member", wsA))).body!;
    const inB = (await range(cookie("member", wsB))).body!;
    assert.equal(inA.workspaceId, wsA);
    assert.equal(inB.workspaceId, wsB);
    assert.ok(inA.items.every((i) => i.title.startsWith("A ")));
    assert.ok(inB.items.every((i) => i.title.startsWith("B ")));
    assert.equal(inB.canReschedule, true);
    const unB = await unscheduledRoute.GET(req("GET", "/api/calendar/unscheduled", { cookie: cookie("member", wsB) }));
    const unBody = (await unB.json()) as { workspaceId: string; items: { title: string }[] };
    assert.equal(unBody.workspaceId, wsB);
    assert.ok(!unBody.items.some((i) => i.title === "A undated"));
  });

  it("filter options list active members by id and name only", async () => {
    const res = await filtersRoute.GET(req("GET", "/api/calendar/filters", { cookie: cookie("member") }));
    assert.equal(res.status, 200);
    const raw = await res.text();
    const body = JSON.parse(raw) as { members: { id: string; name: string }[]; projects: { id: string }[] };
    assert.deepEqual(
      body.members.map((m) => m.name).sort(),
      ["Cal admin", "Cal member", "Cal owner", "Cal viewer"],
    );
    for (const m of body.members) assert.deepEqual(Object.keys(m).sort(), ["id", "name"]);
    assert.ok(!raw.includes("@example.com"), "no emails");
    assert.ok(!raw.includes("Cal suspended") && !raw.includes("Cal removed"));
    assert.ok(!body.projects.some((p) => p.id === projectB));
  });

  it("a range ending on 9999-12-31 works in PostgreSQL; one day past it is rejected", async () => {
    const res = await projectTasksRoute.POST(
      req("POST", `/api/projects/${projectA}/tasks`, { cookie: cookie("owner"), body: { title: "End of calendar", dueDate: "9999-12-31" } }),
      { params: Promise.resolve({ id: projectA }) },
    );
    assert.equal(res.status, 201);
    const end = await range(cookie("member"), "from=9999-11-29&to=9999-12-31");
    assert.equal(end.res.status, 200);
    assert.deepEqual(end.body!.items.map((i) => `${i.date} ${i.title}`), ["9999-12-31 End of calendar"]);
    assert.equal((await range(cookie("member"), "from=1900-01-01&to=1900-02-04")).res.status, 200);
    assert.equal((await range(cookie("member"), "from=9999-12-31&to=10000-01-01")).res.status, 400);
  });

  it("filter options report truncation truthfully beyond both limits", async () => {
    const { MAX_FILTER_PROJECTS, MAX_FILTER_MEMBERS } = await import("../../src/core/calendar/types");
    const { sql } = await import("drizzle-orm");
    const WT = "ws-cal-api-truncation";
    await db().insert(schema.workspaces).values({ id: WT, name: "API truncation", slug: WT, kind: "team" });
    await db().insert(schema.workspaceMembers).values({ workspaceId: WT, userId: id.owner, role: "owner", status: "active" });
    await db().execute(sql`
      insert into project (id, workspace_id, name)
      select 'prj_apitrunc_' || g, ${WT}, 'Trunc project ' || lpad(g::text, 4, '0')
      from generate_series(1, ${MAX_FILTER_PROJECTS + 1}::int) g`);
    await db().execute(sql`
      insert into "user" (id, name, email)
      select 'usr_apitrunc_' || g, 'Trunc member ' || lpad(g::text, 4, '0'), 'apitrunc_' || g || '@example.com'
      from generate_series(1, ${MAX_FILTER_MEMBERS + 1}::int) g`);
    await db().execute(sql`
      insert into workspace_member (workspace_id, user_id, role, status)
      select ${WT}, 'usr_apitrunc_' || g, 'member', 'active' from generate_series(1, ${MAX_FILTER_MEMBERS + 1}::int) g`);

    const res = await filtersRoute.GET(req("GET", "/api/calendar/filters", { cookie: cookie("owner", WT) }));
    assert.equal(res.status, 200);
    const raw = await res.text();
    const body = JSON.parse(raw) as {
      workspaceId: string;
      projects: unknown[];
      members: { id: string; name: string }[];
      projectsTruncated: boolean;
      membersTruncated: boolean;
      projectLimit: number;
      memberLimit: number;
    };
    assert.equal(body.workspaceId, WT);
    assert.equal(body.projects.length, MAX_FILTER_PROJECTS);
    assert.equal(body.projectsTruncated, true);
    assert.equal(body.projectLimit, MAX_FILTER_PROJECTS);
    assert.equal(body.members.length, MAX_FILTER_MEMBERS, "501 seeded + the owner, capped");
    assert.equal(body.membersTruncated, true);
    assert.equal(body.memberLimit, MAX_FILTER_MEMBERS);
    assert.ok(!raw.includes("@example.com"), "truncation never widens what a member entry exposes");

    // Workspace A is small: both lists complete, both flags false.
    const small = (await (await filtersRoute.GET(req("GET", "/api/calendar/filters", { cookie: cookie("owner") }))).json()) as typeof body;
    assert.equal(small.projectsTruncated, false);
    assert.equal(small.membersTruncated, false);
  });

  it("search reaches a project and an active member sorted after the caps, and both filter the calendar", async () => {
    const { MAX_FILTER_PROJECTS, MAX_FILTER_MEMBERS } = await import("../../src/core/calendar/types");
    const { sql } = await import("drizzle-orm");
    const WT = "ws-cal-api-truncation"; // seeded by the truncation test above
    const projectBeyond = `prj_apitrunc_${MAX_FILTER_PROJECTS + 1}`;
    const memberBeyond = `usr_apitrunc_${MAX_FILTER_MEMBERS + 1}`;
    await db().execute(sql`
      insert into task (id, workspace_id, project_id, title, due_date, assignee_id, created_at, updated_at)
      values ('tsk_beyond_project', ${WT}, ${projectBeyond}, 'Beyond project task', '2026-10-09 00:00:00', null, now(), now()),
             ('tsk_beyond_member', ${WT}, 'prj_apitrunc_1', 'Beyond member task', '2026-10-10 00:00:00', ${memberBeyond}, now(), now())`);
    await db().insert(schema.workspaceMembers).values({ workspaceId: WT, userId: id.viewer, role: "viewer", status: "active" });

    const search = async (role: Role, query: string) => {
      const res = await searchRoute.GET(req("GET", `/api/calendar/filters/search?${query}`, { cookie: cookie(role, WT) }));
      return { res, raw: await res.text() };
    };

    // A viewer may search (read-only access is unchanged).
    const projectName = `Trunc project ${String(MAX_FILTER_PROJECTS + 1).padStart(4, "0")}`;
    const p = await search("viewer", `type=projects&q=${encodeURIComponent(projectName)}`);
    assert.equal(p.res.status, 200);
    assert.equal(p.res.headers.get("cache-control"), "no-store");
    const pBody = JSON.parse(p.raw) as { workspaceId: string; results: { id: string; name: string }[] };
    assert.equal(pBody.workspaceId, WT);
    assert.deepEqual(pBody.results, [{ id: projectBeyond, name: projectName }]);

    const memberName = `Trunc member ${String(MAX_FILTER_MEMBERS + 1).padStart(4, "0")}`;
    const m = await search("viewer", `type=members&q=${encodeURIComponent(memberName)}`);
    assert.equal(m.res.status, 200);
    assert.deepEqual((JSON.parse(m.raw) as { results: unknown[] }).results, [{ id: memberBeyond, name: memberName }]);
    assert.ok(!p.raw.includes("@") && !m.raw.includes("@"), "no email in search responses");
    assert.ok(!/"(email|image|role|status|joinedAt)"/.test(m.raw), "only id and name");

    // The selected ids filter the calendar.
    const byProject = await range(cookie("viewer", WT), `${RANGE}&projectId=${projectBeyond}`);
    assert.deepEqual(byProject.body!.items.map((i) => i.title), ["Beyond project task"]);
    const byMember = await range(cookie("viewer", WT), `${RANGE}&assignee=${memberBeyond}`);
    assert.deepEqual(byMember.body!.items.map((i) => i.title), ["Beyond member task"]);
    assert.equal(byMember.body!.canReschedule, false, "viewer remains read-only");
  });

  it("search never returns foreign, suspended or removed rows, and crafted foreign ids still get the generic 400", async () => {
    const search = async (query: string, c = cookie("member")) =>
      (await (await searchRoute.GET(req("GET", `/api/calendar/filters/search?${query}`, { cookie: c }))).json()) as {
        results: { id: string; name: string }[];
      };
    assert.deepEqual((await search("type=projects&q=secret")).results, [], "workspace B's project");
    assert.deepEqual((await search("type=members&q=cal%20outsider")).results, [], "workspace B's owner");
    assert.deepEqual((await search("type=members&q=cal%20suspended")).results, []);
    assert.deepEqual((await search("type=members&q=cal%20removed")).results, []);
    assert.deepEqual((await search("type=members&q=cal_member%40example.com")).results, [], "emails never match");
    const names = (await search("type=members&q=cal")).results.map((r) => r.name).sort();
    assert.deepEqual(names, ["Cal admin", "Cal member", "Cal owner", "Cal viewer"]);

    for (const q of [`${RANGE}&projectId=${projectB}`, `${RANGE}&assignee=${id.outsider}`, `${RANGE}&assignee=${id.suspended}x`]) {
      const { res } = await range(cookie("member"), q);
      assert.equal(res.status, 400, q);
      assert.deepEqual(await res.json(), { error: "Unknown filter value." });
    }
  });

  it("search is authenticated, validated and workspace-scoped", async () => {
    assert.equal((await searchRoute.GET(req("GET", "/api/calendar/filters/search?type=projects&q=a"))).status, 401);
    for (const role of ["suspended", "removed"] as const) {
      const res = await searchRoute.GET(req("GET", "/api/calendar/filters/search?type=projects&q=a", { cookie: cookie(role) }));
      assert.equal(res.status, 403);
    }
    for (const q of ["type=users", "type=projects&q=a&q=b", "type=projects&limit=500", "type=projects&cursor=zz", "type=projects&workspaceId=x"]) {
      const res = await searchRoute.GET(req("GET", `/api/calendar/filters/search?${q}`, { cookie: cookie("member") }));
      assert.equal(res.status, 400, q);
    }
    // An outsider forging workspace A in the cookie searches their own workspace, never A.
    const forged = (await (
      await searchRoute.GET(req("GET", "/api/calendar/filters/search?type=projects&q=calendar", { cookie: cookie("outsider", wsA) }))
    ).json()) as { workspaceId: string; results: { name: string }[] };
    assert.notEqual(forged.workspaceId, wsA);
    assert.ok(!forged.results.some((r) => r.name === "Calendar Project A"));
  });

  it("rejects malformed range queries with 400", async () => {
    for (const q of ["", "from=2026-10-01&to=2026-12-31", `${RANGE}&tz=Bad%2FZone`, `${RANGE}&from=2026-10-01`]) {
      assert.equal((await range(cookie("member"), q)).res.status, 400, q);
    }
  });
});

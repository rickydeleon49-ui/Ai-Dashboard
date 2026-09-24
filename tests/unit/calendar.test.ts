/**
 * Release 2D.1 calendar — desktop (SQLite).
 *
 * 1. Repository parity: the shared fixture (tests/helpers/calendar-fixtures.ts)
 *    returns exactly what the PostgreSQL suite asserts.
 * 2. Bounded reads on a large fixture: only the visible range is returned, the
 *    item cap holds, and unscheduled paging never repeats or skips a task.
 * 3. Desktop routes: GET /api/calendar, /unscheduled and /filters; strict
 *    400s (dates, repeated params, unknown filter ids, assignee filters on
 *    desktop); no-store; rescheduling through the existing task and milestone
 *    routes round-trips a date-only value without shifting a day.
 * 4. The calendar never reads the collaboration or accounts-mode tables.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { cleanup, migrate } from "../helpers/db";
import {
  PARITY_MILESTONES,
  PARITY_TASKS,
  assertCalendarParity,
  collectUnscheduled,
} from "../helpers/calendar-fixtures";
import { LOCAL_WORKSPACE_ID } from "../../src/db/repositories/project-repository";

type Repos = typeof import("../../src/db/repositories");
let repos: Repos;
let projectId: string;
let octTaskId: string;
let milestoneId: string;

before(async () => {
  await migrate();
  repos = await import("../../src/db/repositories");
  const project = await repos.projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Calendar parity" });
  projectId = project.id;
  for (const t of PARITY_TASKS) {
    const created = await repos.taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: t.title,
      ...("dueDate" in t ? { dueDate: t.dueDate } : {}),
      ...("status" in t ? { status: t.status } : {}),
    });
    if (t.title === "Oct 1 plain") octTaskId = created.id;
  }
  for (const m of PARITY_MILESTONES) {
    const created = await repos.milestoneRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: m.title,
      ...("dueDate" in m ? { dueDate: m.dueDate } : {}),
      ...("status" in m ? { status: m.status } : {}),
    });
    if (m.title === "Milestone Oct 15") milestoneId = created.id;
  }
});

after(() => cleanup());

function get(route: { GET: (r: NextRequest) => Promise<Response> }, path: string) {
  return route.GET(new NextRequest(`http://localhost${path}`));
}

describe("calendar repository (SQLite)", () => {
  it("matches the shared parity fixture", async () => {
    await assertCalendarParity(repos.calendarRepository, LOCAL_WORKSPACE_ID, projectId);
  });

  it("refuses any workspace other than the local one, and assignee filters", async () => {
    await assert.rejects(
      () => repos.calendarRepository.listRange("ws_other", { from: "2026-10-01", to: "2026-10-31" }, { status: "all", kind: "all" }, 10),
      /only serves/,
    );
    await assert.rejects(
      () =>
        repos.calendarRepository.listRange(
          LOCAL_WORKSPACE_ID,
          { from: "2026-10-01", to: "2026-10-31" },
          { status: "all", kind: "all", assignee: { kind: "unassigned" } },
          10,
        ),
      /not supported on desktop/,
    );
    assert.equal(await repos.calendarRepository.memberExists(LOCAL_WORKSPACE_ID, "anyone"), false);
  });

  it("stays bounded on a large fixture: 2,920 dated rows, 130 undated", async () => {
    const { sqlite, withLegacySqliteAccess } = await import("../../src/db/client");
    const big = await repos.projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Calendar large fixture" });
    await withLegacySqliteAccess(async () => {
      const insert = sqlite.prepare(
        "INSERT INTO tasks (id, project_id, title, status, priority, due_date, created_at, updated_at) VALUES (?, ?, ?, 'todo', 'medium', ?, ?, ?)",
      );
      const run = sqlite.transaction(() => {
        let n = 0;
        for (let day = 0; day < 365; day++) {
          const date = new Date(Date.UTC(2025, 0, 1 + day)).toISOString().slice(0, 10);
          for (let k = 0; k < 8; k++) {
            n += 1;
            insert.run(`tsk_big_${n}`, big.id, `Big ${date} #${k}`, date, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
          }
        }
        // 130 undated, many sharing one created_at to exercise the (created_at, id) tiebreak.
        for (let u = 0; u < 130; u++) {
          const at = u < 60 ? "2025-06-01T00:00:00.000Z" : `2025-06-01T00:00:${String(u % 60).padStart(2, "0")}.500Z`;
          insert.run(`tsk_undated_${String(u).padStart(3, "0")}`, big.id, `Undated ${u}`, null, at, at);
        }
      });
      run();
    });

    const started = Date.now();
    const march = await repos.calendarRepository.listRange(
      LOCAL_WORKSPACE_ID,
      { from: "2025-03-01", to: "2025-03-31" },
      { status: "all", kind: "tasks", projectId: big.id },
      1000,
    );
    assert.equal(march.items.length, 31 * 8, "only the requested month");
    assert.equal(march.truncated, false);
    assert.ok(march.items.every((i) => i.date >= "2025-03-01" && i.date <= "2025-03-31"));
    assert.ok(Date.now() - started < 2000, "range read stays fast on a large table");

    const capped = await repos.calendarRepository.listRange(
      LOCAL_WORKSPACE_ID,
      { from: "2025-01-01", to: "2025-02-11" },
      { status: "all", kind: "tasks", projectId: big.id },
      100,
    );
    assert.equal(capped.items.length, 100);
    assert.equal(capped.truncated, true);

    const { seen, pages } = await collectUnscheduled(repos.calendarRepository, LOCAL_WORKSPACE_ID, 25);
    assert.equal(seen.filter((id) => id.startsWith("tsk_undated_")).length, 130, "every undated task, once");
    assert.equal(pages, Math.ceil(132 / 25));
  });
});

describe("calendar routes (desktop)", () => {
  it("GET /api/calendar returns the range with no-store and rescheduling allowed", async () => {
    const route = await import("../../src/app/api/calendar/route");
    const res = await get(route, "/api/calendar?from=2026-09-28&to=2026-11-08&tz=America%2FLos_Angeles");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as { workspaceId: string; items: { title: string; date: string }[]; canReschedule: boolean; timeZone: string; today: string };
    assert.equal(body.workspaceId, LOCAL_WORKSPACE_ID);
    assert.equal(body.canReschedule, true);
    assert.equal(body.timeZone, "America/Los_Angeles");
    assert.match(body.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(body.items.some((i) => i.title === "Oct 1 plain" && i.date === "2026-10-01"));
  });

  it("rejects invalid queries, unknown filter ids and desktop assignee filters with 400", async () => {
    const route = await import("../../src/app/api/calendar/route");
    const unscheduled = await import("../../src/app/api/calendar/unscheduled/route");
    const cases = [
      "/api/calendar",
      "/api/calendar?from=2026-10-01&to=2026-12-31",
      "/api/calendar?from=2026-02-30&to=2026-03-01",
      "/api/calendar?from=2026-10-01&to=2026-10-31&from=2026-10-02",
      "/api/calendar?from=2026-10-01&to=2026-10-31&tz=Nowhere%2FLand",
      "/api/calendar?from=2026-10-01&to=2026-10-31&assignee=me",
      "/api/calendar?from=2026-10-01&to=2026-10-31&assignee=unassigned",
    ];
    for (const path of cases) {
      const res = await get(route, path);
      assert.equal(res.status, 400, path);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
    const unknown = await get(route, "/api/calendar?from=2026-10-01&to=2026-10-31&projectId=prj_missing");
    assert.equal(unknown.status, 400);
    assert.deepEqual(await unknown.json(), { error: "Unknown filter value." });
    assert.equal((await get(unscheduled, "/api/calendar/unscheduled?cursor=bogus")).status, 400);
    assert.equal((await get(unscheduled, "/api/calendar/unscheduled?assignee=me")).status, 400);
  });

  it("GET /api/calendar/filters lists projects and no members on desktop", async () => {
    const route = await import("../../src/app/api/calendar/filters/route");
    const res = await get(route, "/api/calendar/filters");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { projects: { id: string; name: string }[]; members: unknown[] };
    assert.ok(body.projects.some((p) => p.id === projectId && p.name === "Calendar parity"));
    assert.deepEqual(body.members, []);
    assert.equal((await get(route, "/api/calendar/filters?x=1")).status, 400);
  });

  it("a range ending on 9999-12-31 and one starting on 1900-01-01 both succeed", async () => {
    const route = await import("../../src/app/api/calendar/route");
    const end = await get(route, "/api/calendar?from=9999-11-29&to=9999-12-31&tz=UTC");
    assert.equal(end.status, 200);
    const endBody = (await end.json()) as { items: { title: string; date: string }[] };
    assert.deepEqual(endBody.items.map((i) => `${i.date} ${i.title}`), [
      "9999-12-31 Last milestone",
      "9999-12-31 Last supported day",
    ]);
    const start = await get(route, "/api/calendar?from=1900-01-01&to=1900-02-04");
    assert.equal(start.status, 200);
    assert.deepEqual(((await start.json()) as { items: { title: string }[] }).items.map((i) => i.title), ["First supported day"]);
    assert.equal((await get(route, "/api/calendar?from=9999-12-31&to=10000-01-01")).status, 400);
  });

  it("rescheduling through the existing routes round-trips date-only values", async () => {
    const taskRoute = await import("../../src/app/api/tasks/[id]/route");
    const milestoneRoute = await import("../../src/app/api/projects/[id]/milestones/[milestoneId]/route");
    const calendar = await import("../../src/app/api/calendar/route");

    const patchTask = await taskRoute.PATCH(
      new NextRequest(`http://localhost/api/tasks/${octTaskId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dueDate: "2026-10-04" }),
      }),
      { params: Promise.resolve({ id: octTaskId }) },
    );
    assert.equal(patchTask.status, 200);
    const patchMilestone = await milestoneRoute.PATCH(
      new NextRequest(`http://localhost/api/projects/${projectId}/milestones/${milestoneId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dueDate: "2026-11-01" }),
      }),
      { params: Promise.resolve({ id: projectId, milestoneId }) },
    );
    assert.equal(patchMilestone.status, 200);

    const res = await get(calendar, "/api/calendar?from=2026-09-28&to=2026-11-08&tz=Pacific%2FAuckland");
    const body = (await res.json()) as { items: { id: string; date: string }[] };
    assert.equal(body.items.find((i) => i.id === octTaskId)?.date, "2026-10-04");
    assert.equal(body.items.find((i) => i.id === milestoneId)?.date, "2026-11-01");
    const stored = await repos.taskRepository.findById(LOCAL_WORKSPACE_ID, octTaskId);
    assert.equal(stored?.dueDate, "2026-10-04", "SQLite stores the date-only string unchanged");
  });
});

describe("calendar filter options beyond the project limit (desktop)", () => {
  it("reports truncation truthfully at, and one beyond, the limit", async () => {
    const { MAX_FILTER_PROJECTS } = await import("../../src/core/calendar/types");
    const { sqlite, withLegacySqliteAccess } = await import("../../src/db/client");
    const route = await import("../../src/app/api/calendar/filters/route");
    const count = async () =>
      withLegacySqliteAccess(async () => (sqlite.prepare("SELECT count(*) AS n FROM projects").get() as { n: number }).n);
    const addUpTo = async (target: number) =>
      withLegacySqliteAccess(async () => {
        const have = (sqlite.prepare("SELECT count(*) AS n FROM projects").get() as { n: number }).n;
        const insert = sqlite.prepare("INSERT INTO projects (id, name) VALUES (?, ?)");
        sqlite.transaction(() => {
          for (let i = have; i < target; i++) insert.run(`prj_limit_${i}`, `ZZ Limit project ${String(i).padStart(4, "0")}`);
        })();
      });

    await addUpTo(MAX_FILTER_PROJECTS);
    assert.equal(await count(), MAX_FILTER_PROJECTS);
    let body = (await (await get(route, "/api/calendar/filters")).json()) as {
      projects: unknown[];
      projectsTruncated: boolean;
      projectLimit: number;
      membersTruncated: boolean;
    };
    assert.equal(body.projects.length, MAX_FILTER_PROJECTS);
    assert.equal(body.projectsTruncated, false, "exactly at the limit is complete");
    assert.equal(body.projectLimit, MAX_FILTER_PROJECTS);

    await addUpTo(MAX_FILTER_PROJECTS + 1);
    body = (await (await get(route, "/api/calendar/filters")).json()) as typeof body;
    assert.equal(body.projects.length, MAX_FILTER_PROJECTS);
    assert.equal(body.projectsTruncated, true, "one beyond the limit is reported");
    assert.equal(body.membersTruncated, false);
  });

  it("desktop project search reaches a project sorted after the first 500 and filters the calendar by it", async () => {
    const { MAX_FILTER_PROJECTS } = await import("../../src/core/calendar/types");
    const search = await import("../../src/app/api/calendar/filters/search/route");
    const calendar = await import("../../src/app/api/calendar/route");
    const filters = await import("../../src/app/api/calendar/filters/route");

    // The previous test left MAX_FILTER_PROJECTS + 1 projects; the "ZZ …" ones sort last.
    const initial = (await (await get(filters, "/api/calendar/filters")).json()) as { projects: { id: string }[] };
    const lastId = `prj_limit_${MAX_FILTER_PROJECTS}`;
    assert.ok(!initial.projects.some((p) => p.id === lastId), "the target is beyond the initial list");

    const res = await get(search, `/api/calendar/filters/search?type=projects&q=${encodeURIComponent(`zz limit project ${String(MAX_FILTER_PROJECTS).padStart(4, "0")}`)}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as { workspaceId: string; results: { id: string; name: string }[]; nextCursor: string | null };
    assert.equal(body.workspaceId, LOCAL_WORKSPACE_ID);
    assert.deepEqual(body.results.map((r) => r.id), [lastId]);
    for (const r of body.results) assert.deepEqual(Object.keys(r).sort(), ["id", "name"]);

    await repos.taskRepository.create(LOCAL_WORKSPACE_ID, { projectId: lastId, title: "Beyond-the-cap task", dueDate: "2026-10-09" });
    const filtered = await get(calendar, `/api/calendar?from=2026-09-28&to=2026-11-08&projectId=${lastId}`);
    assert.equal(filtered.status, 200);
    assert.deepEqual(((await filtered.json()) as { items: { title: string }[] }).items.map((i) => i.title), ["Beyond-the-cap task"]);
  });

  it("desktop search pages through every project exactly once, matches wildcards literally, and refuses members", async () => {
    const search = await import("../../src/app/api/calendar/filters/search/route");
    const { sqlite, withLegacySqliteAccess } = await import("../../src/db/client");
    const total = await withLegacySqliteAccess(
      async () => (sqlite.prepare("SELECT count(*) AS n FROM projects").get() as { n: number }).n,
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/api/calendar/filters/search?type=projects&limit=50${cursor ? `&cursor=${cursor}` : ""}`;
      const page = (await (await get(search, url)).json()) as { results: { id: string }[]; nextCursor: string | null };
      seen.push(...page.results.map((r) => r.id));
      cursor = page.nextCursor;
      pages += 1;
      assert.ok(pages < 100);
    } while (cursor);
    assert.equal(seen.length, total, "every project is reachable");
    assert.equal(new Set(seen).size, seen.length, "no project repeated");

    for (const wildcard of ["%", "_", "\\"]) {
      const res = await get(search, `/api/calendar/filters/search?type=projects&q=${encodeURIComponent(wildcard)}`);
      assert.deepEqual(((await res.json()) as { results: unknown[] }).results, [], `"${wildcard}" is literal`);
    }
    assert.equal((await get(search, "/api/calendar/filters/search?type=members&q=a")).status, 400);
    assert.equal((await get(search, "/api/calendar/filters/search?type=projects&q=a&q=b")).status, 400);
    assert.equal((await get(search, "/api/calendar/filters/search?type=projects&cursor=bogus")).status, 400);
  });
});

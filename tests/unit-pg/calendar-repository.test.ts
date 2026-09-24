/**
 * Release 2D.1 calendar — PostgreSQL repository.
 *
 * 1. Parity with SQLite on the shared fixture (tests/helpers/calendar-fixtures.ts).
 * 2. Workspace isolation: another workspace's tasks, milestones, projects and
 *    members never appear, and foreign ids never validate.
 * 3. Assignee filters (user / unassigned) and that they exclude milestones.
 * 4. Filter options expose only id + name of ACTIVE members.
 * 5. Bounded reads on a large fixture, and exact unscheduled paging even when
 *    created_at carries microseconds (rows written by SQL now()).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";
import {
  PARITY_MILESTONES,
  PARITY_TASKS,
  assertCalendarParity,
  collectUnscheduled,
} from "../helpers/calendar-fixtures";

const WA = "ws-cal-a";
const WB = "ws-cal-b";
const U = {
  owner: "a1000000-0000-4000-8000-000000000001",
  member: "a2000000-0000-4000-8000-000000000002",
  suspended: "a3000000-0000-4000-8000-000000000003",
  outsider: "a4000000-0000-4000-8000-000000000004",
};

let repo: import("../../src/db/repositories/postgres-calendar-repository").PostgresCalendarRepository;
let db: ReturnType<typeof import("../../src/db/pg-client").getPgDb>;
let schema: typeof import("../../src/db/schema.pg");
let projectA: string;
let projectB: string;

before(async () => {
  await migrate();
  db = (await import("../../src/db/pg-client")).getPgDb();
  schema = await import("../../src/db/schema.pg");
  const { PostgresCalendarRepository } = await import("../../src/db/repositories/postgres-calendar-repository");
  const { PostgresProjectRepository } = await import("../../src/db/repositories/postgres-project-repository");
  const { PostgresTaskRepository } = await import("../../src/db/repositories/postgres-task-repository");
  const { PostgresMilestoneRepository } = await import("../../src/db/repositories/postgres-milestone-repository");
  repo = new PostgresCalendarRepository();

  await db.insert(schema.users).values([
    { id: U.owner, name: "Olive Owner", email: "olive@example.com", image: "https://img/olive" },
    { id: U.member, name: "Mo Member", email: "mo@example.com" },
    { id: U.suspended, name: "Sid Suspended", email: "sid@example.com" },
    { id: U.outsider, name: "Otto Outsider", email: "otto@example.com" },
  ]);
  await db.insert(schema.workspaces).values([
    { id: WA, name: "Cal A", slug: WA, kind: "team" },
    { id: WB, name: "Cal B", slug: WB, kind: "team" },
  ]);
  await db.insert(schema.workspaceMembers).values([
    { workspaceId: WA, userId: U.owner, role: "owner", status: "active" },
    { workspaceId: WA, userId: U.member, role: "member", status: "active" },
    { workspaceId: WA, userId: U.suspended, role: "member", status: "suspended" },
    { workspaceId: WB, userId: U.outsider, role: "owner", status: "active" },
  ]);

  const projects = new PostgresProjectRepository();
  const tasks = new PostgresTaskRepository();
  const milestones = new PostgresMilestoneRepository();
  projectA = (await projects.create(WA, { name: "Cal Project A" })).id;
  projectB = (await projects.create(WB, { name: "Cal Project B (secret)" })).id;

  for (const t of PARITY_TASKS) {
    await tasks.create(
      WA,
      {
        projectId: projectA,
        title: t.title,
        ...("dueDate" in t ? { dueDate: t.dueDate } : {}),
        ...("status" in t ? { status: t.status } : {}),
      },
      { actorUserId: U.owner },
    );
  }
  for (const m of PARITY_MILESTONES) {
    await milestones.create(WA, {
      projectId: projectA,
      title: m.title,
      ...("dueDate" in m ? { dueDate: m.dueDate } : {}),
      ...("status" in m ? { status: m.status } : {}),
    });
  }
  // Workspace B has items on the very same days — they must never leak into A.
  await tasks.create(WB, { projectId: projectB, title: "B secret task", dueDate: "2026-10-01" }, { actorUserId: U.outsider });
  await tasks.create(WB, { projectId: projectB, title: "B secret undated" }, { actorUserId: U.outsider });
  await milestones.create(WB, { projectId: projectB, title: "B secret milestone", dueDate: "2026-10-15" });
});

after(() => cleanup());

describe("calendar repository (PostgreSQL)", () => {
  it("matches the shared parity fixture (same results as SQLite)", async () => {
    await assertCalendarParity(repo, WA, projectA);
  });

  it("never returns another workspace's items, projects or members", async () => {
    const a = await repo.listRange(WA, { from: "2026-09-28", to: "2026-11-08" }, { status: "all", kind: "all" }, 1000);
    assert.ok(!JSON.stringify(a).includes("secret"));
    const b = await repo.listRange(WB, { from: "2026-09-28", to: "2026-11-08" }, { status: "all", kind: "all" }, 1000);
    assert.deepEqual(
      b.items.map((i) => `${i.date} ${i.kind} ${i.title}`),
      ["2026-10-01 task B secret task", "2026-10-15 milestone B secret milestone"],
    );

    // A foreign project id as a filter matches nothing and does not validate.
    const foreign = await repo.listRange(WA, { from: "2026-09-28", to: "2026-11-08" }, { status: "all", kind: "all", projectId: projectB }, 1000);
    assert.deepEqual(foreign.items, []);
    assert.equal(await repo.projectExists(WA, projectB), false);
    assert.equal(await repo.memberExists(WA, U.outsider), false);
    assert.equal(await repo.memberExists(WA, U.suspended), true, "historical members still validate as a filter");

    const unscheduled = await repo.listUnscheduled(WA, { status: "all" }, { limit: 50 });
    assert.ok(!unscheduled.items.some((i) => i.title.includes("secret")));
    const options = await repo.listFilterOptions(WA);
    assert.ok(!options.projects.some((p) => p.id === projectB));
  });

  it("assignee filters match tasks only; unassigned is explicit", async () => {
    const tasks = new (await import("../../src/db/repositories/postgres-task-repository")).PostgresTaskRepository();
    await tasks.create(WA, { projectId: projectA, title: "Mo's Oct 5", dueDate: "2026-10-05", assigneeId: U.member }, { actorUserId: U.owner });
    const mine = await repo.listRange(
      WA,
      { from: "2026-10-01", to: "2026-10-31" },
      { status: "all", kind: "all", assignee: { kind: "user", userId: U.member } },
      1000,
    );
    assert.deepEqual(mine.items.map((i) => i.title), ["Mo's Oct 5"]);
    assert.equal(mine.items[0]?.assigneeId, U.member);
    const unassigned = await repo.listRange(
      WA,
      { from: "2026-10-01", to: "2026-10-31" },
      { status: "all", kind: "all", assignee: { kind: "unassigned" } },
      1000,
    );
    assert.ok(unassigned.items.every((i) => i.kind === "task" && i.assigneeId === null));
    assert.ok(!unassigned.items.some((i) => i.title === "Mo's Oct 5"));
  });

  it("filter options expose only id and name of active members", async () => {
    const options = await repo.listFilterOptions(WA);
    assert.deepEqual(options.members.map((m) => m.name), ["Mo Member", "Olive Owner"]);
    for (const m of options.members) assert.deepEqual(Object.keys(m).sort(), ["id", "name"]);
    const raw = JSON.stringify(options);
    assert.ok(!raw.includes("@example.com") && !raw.includes("https://img") && !raw.includes("Sid"));
    assert.equal(options.membersTruncated, false);
    assert.equal(options.projectsTruncated, false);
  });

  it("filter lists report truncation truthfully, with independent bounds, beyond both limits", async () => {
    const { MAX_FILTER_PROJECTS, MAX_FILTER_MEMBERS } = await import("../../src/core/calendar/types");
    const { sql } = await import("drizzle-orm");
    const WT = "ws-cal-truncation";
    await db.insert(schema.workspaces).values({ id: WT, name: "Truncation", slug: WT, kind: "team" });
    const addProjects = (from: number, to: number) =>
      db.execute(sql`
        insert into project (id, workspace_id, name)
        select 'prj_trunc_' || lpad(g::text, 4, '0'), ${WT}, 'Project ' || lpad(g::text, 4, '0')
        from generate_series(${from}::int, ${to}::int) g`);
    const addMembers = async (from: number, to: number, status: string) => {
      await db.execute(sql`
        insert into "user" (id, name, email)
        select 'usr_trunc_' || ${status} || lpad(g::text, 4, '0'), 'Member ' || lpad(g::text, 4, '0'),
               'trunc_' || ${status} || g || '@example.com'
        from generate_series(${from}::int, ${to}::int) g`);
      await db.execute(sql`
        insert into workspace_member (workspace_id, user_id, role, status)
        select ${WT}, 'usr_trunc_' || ${status} || lpad(g::text, 4, '0'), 'member', ${status}
        from generate_series(${from}::int, ${to}::int) g`);
    };

    // Exactly at both limits: complete lists, nothing truncated. Suspended
    // members never count toward the member limit.
    await addProjects(1, MAX_FILTER_PROJECTS);
    await addMembers(1, MAX_FILTER_MEMBERS, "active");
    await addMembers(1, 25, "suspended");
    let options = await repo.listFilterOptions(WT);
    assert.equal(options.projects.length, MAX_FILTER_PROJECTS);
    assert.equal(options.projectsTruncated, false);
    assert.equal(options.members.length, MAX_FILTER_MEMBERS);
    assert.equal(options.membersTruncated, false);
    assert.equal(options.projectLimit, MAX_FILTER_PROJECTS);
    assert.equal(options.memberLimit, MAX_FILTER_MEMBERS);

    // One beyond the project limit only: projects truncated, members not.
    await addProjects(MAX_FILTER_PROJECTS + 1, MAX_FILTER_PROJECTS + 1);
    options = await repo.listFilterOptions(WT);
    assert.equal(options.projects.length, MAX_FILTER_PROJECTS);
    assert.equal(options.projectsTruncated, true);
    assert.equal(options.membersTruncated, false, "bounds are independent");
    assert.equal(options.projects.at(-1)?.name, `Project ${String(MAX_FILTER_PROJECTS).padStart(4, "0")}`, "the first N by name");

    // Well beyond both limits.
    await addProjects(MAX_FILTER_PROJECTS + 2, MAX_FILTER_PROJECTS + 40);
    await addMembers(MAX_FILTER_MEMBERS + 1, MAX_FILTER_MEMBERS + 40, "active");
    options = await repo.listFilterOptions(WT);
    assert.equal(options.projects.length, MAX_FILTER_PROJECTS);
    assert.equal(options.projectsTruncated, true);
    assert.equal(options.members.length, MAX_FILTER_MEMBERS);
    assert.equal(options.membersTruncated, true);
    for (const m of options.members) assert.deepEqual(Object.keys(m).sort(), ["id", "name"]);
  });

  it("search reaches projects and active members beyond the caps, and never inactive or foreign rows", async () => {
    const { MAX_FILTER_PROJECTS, MAX_FILTER_MEMBERS } = await import("../../src/core/calendar/types");
    const WT = "ws-cal-truncation";
    // Added by the previous test: 540 projects, 540 active members, 25 suspended.
    await db.insert(schema.users).values({ id: "usr_trunc_removed", name: "Member Removed Person", email: "gone@example.com" });
    await db.insert(schema.workspaceMembers).values({ workspaceId: WT, userId: "usr_trunc_removed", role: "member", status: "removed" });

    const beyondProject = `Project ${String(MAX_FILTER_PROJECTS + 1).padStart(4, "0")}`;
    const p = await repo.searchFilterOptions(WT, "projects", { q: beyondProject.toUpperCase(), limit: 25 });
    assert.deepEqual(p.results.map((r) => r.name), [beyondProject], "case-insensitive, beyond the cap");

    const beyondMember = `Member ${String(MAX_FILTER_MEMBERS + 1).padStart(4, "0")}`;
    const m = await repo.searchFilterOptions(WT, "members", { q: beyondMember, limit: 25 });
    assert.deepEqual(m.results.map((r) => r.name), [beyondMember]);
    for (const r of [...p.results, ...m.results]) assert.deepEqual(Object.keys(r).sort(), ["id", "name"]);

    // "Member 0001" names both an active and a suspended member: only the active one.
    const shared = await repo.searchFilterOptions(WT, "members", { q: "member 0001", limit: 25 });
    assert.deepEqual(shared.results.map((r) => r.id), ["usr_trunc_active0001"]);
    assert.deepEqual((await repo.searchFilterOptions(WT, "members", { q: "removed person", limit: 25 })).results, []);
    // Matching is on names only — an email address never matches.
    assert.deepEqual((await repo.searchFilterOptions(WT, "members", { q: "gone@example.com", limit: 25 })).results, []);
    assert.deepEqual((await repo.searchFilterOptions(WT, "members", { q: "trunc_active", limit: 25 })).results, []);

    // Other workspaces never leak into a search.
    assert.deepEqual((await repo.searchFilterOptions(WA, "projects", { q: "secret", limit: 25 })).results, []);
    assert.deepEqual((await repo.searchFilterOptions(WA, "members", { q: "otto", limit: 25 })).results, []);
    assert.deepEqual((await repo.searchFilterOptions(WT, "projects", { q: "cal project", limit: 25 })).results, []);

    // Wildcards are literal.
    for (const w of ["%", "_", "\\"]) {
      assert.deepEqual((await repo.searchFilterOptions(WT, "projects", { q: w, limit: 25 })).results, [], w);
    }

    // Keyset paging reaches every row exactly once, in both lists.
    for (const [type, expected] of [["projects", 540], ["members", 540]] as const) {
      const seen: string[] = [];
      let cursor: import("../../src/core/calendar/query").FilterSearchCursor | undefined;
      let pages = 0;
      for (;;) {
        const page = await repo.searchFilterOptions(WT, type, { q: "", limit: 50, cursor });
        seen.push(...page.results.map((r) => r.id));
        pages += 1;
        if (!page.nextCursor) break;
        const { decodeFilterSearchCursor } = await import("../../src/core/calendar/query");
        cursor = decodeFilterSearchCursor(page.nextCursor);
        assert.ok(pages < 100);
      }
      assert.equal(seen.length, expected, `${type}: every row`);
      assert.equal(new Set(seen).size, seen.length, `${type}: no repeats`);
      if (type === "members") assert.ok(!seen.some((id) => id.includes("suspended") || id.includes("removed")));
    }
  });

  it("stays bounded on a large fixture and pages exactly across microsecond created_at ties", async () => {
    const big = (await new (await import("../../src/db/repositories/postgres-project-repository")).PostgresProjectRepository().create(WA, { name: "Big" })).id;
    const client = (await import("../../src/db/pg-client")).getPgDb();
    const { sql } = await import("drizzle-orm");
    await client.execute(sql`
      insert into task (id, workspace_id, project_id, title, due_date, created_at, updated_at)
      select 'tsk_big_' || g, ${WA}, ${big}, 'Big ' || g,
             timestamp '2025-01-01' + ((g % 365) * interval '1 day'), now(), now()
      from generate_series(1, 2920) g
    `);
    // Undated rows written by SQL now(): microsecond timestamps, many identical.
    await client.execute(sql`
      insert into task (id, workspace_id, project_id, title, due_date, created_at, updated_at)
      select 'tsk_undated_' || lpad(g::text, 3, '0'), ${WA}, ${big}, 'Undated ' || g, null,
             timestamp '2025-06-01 00:00:00.123456' + ((g / 40) * interval '1 microsecond'), now()
      from generate_series(1, 130) g
    `);

    const started = Date.now();
    const march = await repo.listRange(WA, { from: "2025-03-01", to: "2025-03-31" }, { status: "all", kind: "tasks", projectId: big }, 1000);
    assert.equal(march.items.length, 31 * 8);
    assert.ok(march.items.every((i) => i.date >= "2025-03-01" && i.date <= "2025-03-31"));
    assert.ok(Date.now() - started < 2000);

    const capped = await repo.listRange(WA, { from: "2025-01-01", to: "2025-02-11" }, { status: "all", kind: "tasks", projectId: big }, 100);
    assert.equal(capped.items.length, 100);
    assert.equal(capped.truncated, true);

    const { seen } = await collectUnscheduled(repo, WA, 25);
    assert.equal(seen.filter((id) => id.startsWith("tsk_undated_")).length, 130, "every undated task exactly once");
    assert.ok(!seen.some((id) => id.startsWith("tsk_big_")));

    // The range predicate is served by the existing (workspace_id, due_date) index.
    await client.execute(sql`analyze task`);
    const plan = await client.execute(sql`
      explain select id from task
      where workspace_id = ${WA} and due_date >= ${"2025-03-01"}::date and due_date < (${"2025-03-31"}::date + 1)
    `);
    assert.match(JSON.stringify(plan.rows), /task_workspace_due_idx/);
  });
});

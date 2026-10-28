/**
 * Date-only due dates on the project tasks page — genuine browser, production
 * build, desktop/SQLite server running in America/Los_Angeles.
 *
 * Regression: the board formatted due dates in the local zone, so a server and
 * browser in different zones rendered different calendar days and React threw
 * hydration error #418. A due date's day is its stored UTC date (2D.1 §2); only
 * "today" (for overdue) comes from the browser's zone.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Page } from "playwright";
import { baseURL, newPage, pageErrors, start, stop } from "./helpers";

const SERVER_TZ = "America/Los_Angeles";
// Oct 14 in UTC and Los Angeles, already Oct 15 in Auckland.
const NOW = new Date("2026-10-14T12:00:00.000Z");
let seedPage: Page;
let projectId = "";
const ids: Record<string, string> = {};

async function api(path: string, method: string, data?: unknown) {
  const res = await seedPage.request.fetch(`${baseURL}${path}`, { method, data });
  assert.ok(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`);
  return res.json();
}

const due = (page: Page, title: string) => page.locator(`#task-${ids[title]}`).getByTestId("task-due");

before(async () => {
  await start({ timeZone: SERVER_TZ });
  seedPage = await newPage();
  const { project } = await api("/api/projects", "POST", { name: "Task Dates E2E", source: "manual", type: "software", status: "active" });
  projectId = project.id;
  const task = async (title: string, extra: Record<string, unknown>) =>
    (ids[title] = (await api(`/api/projects/${projectId}/tasks`, "POST", { title, ...extra })).task.id);

  ids["Launch"] = (await api(`/api/projects/${projectId}/milestones`, "POST", { title: "Launch", dueDate: "2026-10-20" })).milestone.id;
  await task("Overdue chore", { dueDate: "2026-10-02" });
  await task("Finished chore", { dueDate: "2026-10-02", status: "done" });
  await task("Due Oct 14", { dueDate: "2026-10-14" });
  await task("Due Oct 15", { dueDate: "2026-10-15" });
});

after(async () => stop());

describe("task due dates (server in America/Los_Angeles)", () => {
  it("server-renders the stored calendar day on the tasks and project pages", async () => {
    const tasksHtml = await (await seedPage.request.get(`${baseURL}/projects/${projectId}/tasks`)).text();
    assert.match(tasksHtml, /Oct 2, 2026/);
    assert.match(tasksHtml, /Oct 20, 2026/);
    assert.doesNotMatch(tasksHtml, /Oct 1, 2026|Oct 19, 2026/);

    const projectHtml = await (await seedPage.request.get(`${baseURL}/projects/${projectId}`)).text();
    assert.match(projectHtml, /Oct 20, 2026/);
    assert.doesNotMatch(projectHtml, /Oct 19, 2026/);
  });

  for (const tz of ["UTC", "America/Los_Angeles", "Pacific/Auckland"]) {
    it(`hydrates without errors and shows the stored day in ${tz}`, async () => {
      const page = await newPage({ timezoneId: tz });
      await page.clock.setFixedTime(NOW);
      await page.goto(`/projects/${projectId}/tasks`, { waitUntil: "domcontentloaded" });
      // data-overdue appears only after hydration, once the browser's zone is known.
      await due(page, "Overdue chore").and(page.locator('[data-overdue="true"]')).waitFor();

      assert.equal(await due(page, "Overdue chore").textContent(), "Oct 2, 2026");
      assert.equal(await due(page, "Due Oct 14").textContent(), "Oct 14, 2026");
      assert.equal(await due(page, "Due Oct 15").textContent(), "Oct 15, 2026");
      assert.equal(await page.getByTestId("milestone-due").textContent(), "Due Oct 20, 2026");

      // Overdue compares whole days against the browser's today.
      const overdue = async (title: string) => (await due(page, title).getAttribute("data-overdue")) === "true";
      assert.equal(await overdue("Finished chore"), false, "done tasks are never overdue");
      assert.equal(await overdue("Due Oct 14"), tz === "Pacific/Auckland", `Oct 14 overdue in ${tz}`);
      assert.equal(await overdue("Due Oct 15"), false);

      assert.deepEqual(pageErrors(page), []);
      await page.context().close();
    });
  }
});

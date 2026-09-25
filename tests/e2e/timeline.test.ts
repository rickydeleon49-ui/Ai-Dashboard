/**
 * Release 2D.2 timeline — genuine browser interaction (Chromium, production
 * build, desktop/SQLite server). The browser clock is pinned to
 * 2026-10-14T12:00Z so the timeline opens on October 2026.
 *
 * 1. The Timeline entry in project navigation.
 * 2. Markers on the right day in several zones, across daylight-saving changes.
 * 3. Non-colour status text, conflicts, dependency lines and blocking paths,
 *    and table parity with the chart.
 * 4. Zoom, Previous / Next / Today, the supported calendar's ends.
 * 5. Undated work, empty, error + Retry, truncated and unavailable states.
 * 6. A slow response for an old window never replaces the current one.
 * 7. Small screens scroll the grid, not the page.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Page, Route } from "playwright";
import { baseURL, newPage, pageErrors, start, stop } from "./helpers";

const NOW = new Date("2026-10-14T12:00:00.000Z");
let seedPage: Page;
let projectId = "";
const ids: Record<string, string> = {};

async function api(path: string, method: string, data?: unknown) {
  const res = await seedPage.request.fetch(`${baseURL}${path}`, { method, data });
  assert.ok(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`);
  return res.json();
}

async function openTimeline(opts: { timezoneId?: string; now?: Date } = {}): Promise<Page> {
  const page = await newPage(opts.timezoneId ? { timezoneId: opts.timezoneId } : {});
  await page.clock.setFixedTime(opts.now ?? NOW);
  await page.goto(`/projects/${projectId}/timeline`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("timeline-range").filter({ hasText: /\S/ }).waitFor();
  return page;
}

const range = (page: Page) => page.getByTestId("timeline-range");
const marker = (page: Page, title: string) => page.getByTestId(`marker-${ids[title]}`);
const row = (page: Page, title: string) => page.getByTestId("timeline-table").locator(`tr[data-row="${ids[title]}"]`);
const MONTH_DAY_WIDTH = 32;
const QUARTER_DAY_WIDTH = 12;
const dayIndex = (from: string, day: string) =>
  Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

async function markerLeft(page: Page, title: string): Promise<number> {
  return Number.parseFloat((await marker(page, title).evaluate((el) => (el as HTMLElement).style.left)) || "NaN");
}

before(async () => {
  await start();
  seedPage = await newPage();
  const { project } = await api("/api/projects", "POST", { name: "Timeline E2E", source: "manual", type: "software", status: "active" });
  projectId = project.id;
  const task = async (title: string, extra: Record<string, unknown> = {}) =>
    (ids[title] = (await api(`/api/projects/${projectId}/tasks`, "POST", { title, ...extra })).task.id);
  const depend = (t: string, on: string) => api(`/api/tasks/${ids[t]}/dependencies`, "POST", { dependsOnTaskId: ids[on] });

  ids["Launch"] = (await api(`/api/projects/${projectId}/milestones`, "POST", { title: "Launch", dueDate: "2026-10-20" })).milestone.id;
  await task("Overdue chore", { dueDate: "2026-10-02" });
  await task("Design", { dueDate: "2026-10-05", status: "done" });
  await task("Old approach", { dueDate: "2026-10-08", status: "cancelled" });
  await task("Build", { dueDate: "2026-10-12" });
  await task("API", { dueDate: "2026-10-13" });
  await task("Test", { dueDate: "2026-10-22", milestoneId: ids["Launch"] });
  await task("DST day", { dueDate: "2026-11-01" });
  await task("Idea");
  await task("Docs", { milestoneId: ids["Launch"] });
  await depend("Build", "Design");
  await depend("Build", "API");
  await depend("Test", "Build");
});

after(async () => stop());

describe("timeline (real browser)", () => {
  it("is reachable from the project page and the tasks page", async () => {
    // Real clock: the project page renders relative times, which a pinned browser clock would mismatch.
    const page = await newPage({ timezoneId: "UTC" });
    await page.goto(`/projects/${projectId}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: "Timeline", exact: true }).click();
    await page.getByRole("heading", { name: "Timeline E2E — Timeline", level: 1 }).waitFor();
    await range(page).filter({ hasText: /\S/ }).waitFor();
    assert.deepEqual(pageErrors(page), []);
    // The tasks page is checked for the link only: its existing date formatting
    // is local-zone and hydrates with a mismatch when the browser and server
    // zones differ (pre-existing, outside this release).
    await page.goto(`/projects/${projectId}/tasks`, { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: "Timeline", exact: true }).waitFor();
  });

  for (const tz of ["UTC", "America/New_York", "Pacific/Auckland"]) {
    it(`places date-only items on their day in ${tz}, across daylight-saving changes`, async () => {
      const page = await openTimeline({ timezoneId: tz });
      await range(page).filter({ hasText: "October 2026" }).waitFor();
      // The October grid starts Monday 2026-09-28.
      for (const [title, day] of [["Design", "2026-10-05"], ["Build", "2026-10-12"], ["Launch", "2026-10-20"], ["DST day", "2026-11-01"]] as const) {
        assert.equal(await marker(page, title).getAttribute("data-day"), day, `${title} in ${tz}`);
        assert.equal(await markerLeft(page, title), dayIndex("2026-09-28", day) * MONTH_DAY_WIDTH + MONTH_DAY_WIDTH / 2, `${title} x in ${tz}`);
      }
      // Today is the browser's date: still Oct 14 in New York, already Oct 15 in Auckland.
      const today = tz === "Pacific/Auckland" ? "2026-10-15" : "2026-10-14";
      const left = Number.parseFloat(await page.getByTestId("timeline-today").evaluate((el) => (el as HTMLElement).style.left));
      assert.equal(left, dayIndex("2026-09-28", today) * MONTH_DAY_WIDTH + MONTH_DAY_WIDTH / 2);

      // Quarter view spans the US (Nov 1) and EU (Oct 25) transitions: still one day per column.
      await page.getByRole("button", { name: "Quarter", exact: true }).click();
      await range(page).filter({ hasText: "Q4 2026" }).waitFor();
      assert.equal(await markerLeft(page, "DST day"), dayIndex("2026-09-28", "2026-11-01") * QUARTER_DAY_WIDTH + QUARTER_DAY_WIDTH / 2);
      assert.deepEqual(pageErrors(page), []);
    });
  }

  it("states status in text, flags conflicts, and explains blocking paths — the table matches the chart", async () => {
    const page = await openTimeline({ timezoneId: "UTC" });
    await row(page, "Build").waitFor();
    const text = async (title: string) => ((await row(page, title).textContent()) ?? "").replace(/\s+/g, " ");
    assert.match(await text("Design"), /Done/);
    assert.match(await text("Old approach"), /Cancelled/);
    assert.match(await text("Overdue chore"), /Open · Overdue/);
    assert.match(await text("Build"), /Blocked/);
    assert.match(await text("Build"), /API \(due Oct 13, 2026\)/, "immediate blocker named with its date");
    assert.match(await text("Test"), /Due after its milestone/);
    assert.match(await text("Test"), /Build → API/, "the blocking path as text");
    assert.match(await text("API"), /No/, "API itself is not blocked");

    // Table parity: same items, same order as the chart's label column.
    const chartNames = await page.getByRole("list", { name: "Timeline items" }).locator("li a").allTextContents();
    const tableNames = await page.getByTestId("timeline-table").locator("tbody th a").allTextContents();
    assert.deepEqual(tableNames, chartNames.map((n) => n.replace(/^Milestone: /, "")));
    assert.equal(chartNames.length, 8);

    // Status is announced in text on each chart row, not by colour alone.
    assert.match((await page.getByRole("list", { name: "Timeline items" }).locator("li").filter({ hasText: "Build" }).textContent()) ?? "", /Blocked/);
    assert.deepEqual(pageErrors(page), []);
  });

  it("draws dependency lines between visible tasks, emphasises blocking paths, and can hide them", async () => {
    const page = await openTimeline({ timezoneId: "UTC" });
    const lines = page.getByTestId("timeline-lines");
    await lines.waitFor();
    const edges = await lines.locator("path[data-edge]").evaluateAll((els) =>
      els.map((el) => `${el.getAttribute("data-edge")}:${el.getAttribute("data-on-path")}`).sort(),
    );
    assert.deepEqual(
      edges,
      [`${ids.Build}>${ids.API}:true`, `${ids.Build}>${ids.Design}:false`, `${ids.Test}>${ids.Build}:true`].sort(),
    );
    assert.equal(await lines.evaluate((el) => getComputedStyle(el).pointerEvents), "none");
    // Links under the lines stay clickable.
    await page.getByRole("list", { name: "Timeline items" }).getByRole("link", { name: "Test" }).focus();
    await page.getByLabel("Show dependency lines").uncheck();
    assert.equal(await lines.count(), 0);
    await row(page, "Test").waitFor();
    assert.deepEqual(pageErrors(page), []);
  });

  it("zooms, navigates and returns to today", async () => {
    const page = await openTimeline({ timezoneId: "UTC" });
    await range(page).filter({ hasText: "October 2026" }).waitFor();
    await page.getByRole("button", { name: "Week", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Week", exact: true }).getAttribute("aria-pressed"), "true");
    await range(page).filter({ hasText: "Oct 12 – Oct 18, 2026" }).waitFor();
    await marker(page, "Build").waitFor();
    await page.getByRole("button", { name: "Next week" }).click();
    await range(page).filter({ hasText: "Oct 19 – Oct 25, 2026" }).waitFor();
    await marker(page, "Launch").waitFor();
    await page.getByRole("button", { name: "Today" }).click();
    await range(page).filter({ hasText: "Oct 12 – Oct 18, 2026" }).waitFor();
    await page.getByRole("button", { name: "Month", exact: true }).click();
    await page.getByRole("button", { name: "Previous month" }).click();
    await range(page).filter({ hasText: "September 2026" }).waitFor();
    assert.deepEqual(pageErrors(page), []);
  });

  it("lists undated and partially dated work, and shows an empty range truthfully", async () => {
    const page = await openTimeline({ timezoneId: "UTC" });
    const undated = page.getByTestId("timeline-undated-table");
    await undated.getByText("Idea").waitFor();
    assert.match((await undated.locator(`tr[data-row="${ids.Docs}"]`).textContent()) ?? "", /No due date — milestone target 2026-10-20/);
    assert.match((await undated.locator(`tr[data-row="${ids.Idea}"]`).textContent()) ?? "", /No due date/);
    for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Next month" }).click();
    await range(page).filter({ hasText: "January 2027" }).waitFor();
    await page.getByTestId("timeline-empty").waitFor();
    await undated.getByText("Idea").waitFor();
    assert.deepEqual(pageErrors(page), []);
  });

  it("recovers from a failed load with Retry", async () => {
    const page = await newPage({ timezoneId: "UTC" });
    await page.clock.setFixedTime(NOW);
    let failures = 1;
    await page.route(/\/api\/projects\/[^/]+\/timeline\?/, async (route) => {
      if (failures-- > 0) return route.fulfill({ status: 500, body: "{}" });
      return route.continue();
    });
    await page.goto(`/projects/${projectId}/timeline`, { waitUntil: "domcontentloaded" });
    await page.getByRole("alert").filter({ hasText: "Couldn’t load the timeline." }).waitFor();
    await page.getByRole("button", { name: "Retry" }).click();
    await row(page, "Build").waitFor();
  });

  it("shows truncation guidance and the unavailable-project state", async () => {
    const page = await newPage({ timezoneId: "UTC" });
    await page.clock.setFixedTime(NOW);
    await page.route(/\/api\/projects\/[^/]+\/timeline\?/, async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.truncated = { ...json.truncated, tasks: true, edges: true };
      await route.fulfill({ response, json });
    });
    await page.goto(`/projects/${projectId}/timeline`, { waitUntil: "domcontentloaded" });
    const notice = page.getByTestId("timeline-truncated");
    await notice.waitFor();
    assert.match((await notice.textContent()) ?? "", /more than 400 tasks are due in this range.*some blocking explanations are incomplete \(blocked status is still exact\)/);
    assert.match((await notice.textContent()) ?? "", /narrower zoom/);

    const gone = await newPage({ timezoneId: "UTC" });
    await gone.clock.setFixedTime(NOW);
    await gone.route(/\/api\/projects\/[^/]+\/timeline\?/, (route) =>
      route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"Project not found"}' }),
    );
    await gone.goto(`/projects/${projectId}/timeline`, { waitUntil: "domcontentloaded" });
    await gone.getByTestId("timeline-unavailable").filter({ hasText: "isn’t available in your current workspace" }).waitFor();

    const response = await (await newPage()).goto(`/projects/prj_does_not_exist/timeline`);
    assert.equal(response?.status(), 404);
  });

  it("never lets a slow response for an earlier window replace the current one", async () => {
    const page = await newPage({ timezoneId: "UTC" });
    await page.clock.setFixedTime(NOW);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const seen: string[] = [];
    let settledOld: Promise<void> = Promise.resolve();
    await page.route(/\/api\/projects\/[^/]+\/timeline\?/, async (route: Route) => {
      const anchor = new URL(route.request().url()).searchParams.get("anchor")!;
      seen.push(anchor);
      if (anchor === "2026-10-14") {
        settledOld = (async () => {
          await held;
          await route.continue().catch(() => {});
        })();
        return settledOld;
      }
      return route.continue();
    });
    await page.goto(`/projects/${projectId}/timeline`, { waitUntil: "domcontentloaded" });
    await page.getByText("Loading timeline…").waitFor();
    await page.getByRole("button", { name: "Next month" }).click();
    await range(page).filter({ hasText: "November 2026" }).waitFor();
    await marker(page, "DST day").waitFor();
    release();
    await settledOld;
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.match((await range(page).textContent()) ?? "", /November 2026/);
    assert.equal(await marker(page, "Build").count(), 0, "October's items never replaced November's");
    assert.deepEqual(seen, ["2026-10-14", "2026-11-01"]);
  });

  it("stops navigation at the supported calendar's ends", async () => {
    const end = await openTimeline({ timezoneId: "UTC", now: new Date("9999-12-20T12:00:00Z") });
    await end.getByRole("button", { name: "Quarter", exact: true }).click();
    await range(end).filter({ hasText: "Q4 9999" }).waitFor();
    assert.ok(await end.getByRole("button", { name: "Next quarter" }).isDisabled());
    assert.ok(!(await end.getByRole("button", { name: "Previous quarter" }).isDisabled()));

    const start = await openTimeline({ timezoneId: "UTC", now: new Date("1900-01-05T12:00:00Z") });
    await start.getByRole("button", { name: "Week", exact: true }).click();
    assert.ok(await start.getByRole("button", { name: "Previous week" }).isDisabled());
    assert.deepEqual([...pageErrors(end), ...pageErrors(start)], []);
  });

  it("keeps the page width on a small screen by scrolling the date grid", async () => {
    const page = await openTimeline({ timezoneId: "UTC" });
    await page.setViewportSize({ width: 375, height: 800 });
    await page.getByRole("button", { name: "Quarter", exact: true }).click();
    await range(page).filter({ hasText: "Q4 2026" }).waitFor();
    const scroller = page.getByTestId("timeline-scroll");
    const [scrollWidth, clientWidth] = await scroller.evaluate((el) => [el.scrollWidth, el.clientWidth]);
    assert.ok(scrollWidth > clientWidth, "the grid scrolls horizontally");
    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(pageOverflow <= 1, `page overflows by ${pageOverflow}px`);
  });
});

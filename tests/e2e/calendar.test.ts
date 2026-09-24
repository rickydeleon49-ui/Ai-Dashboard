/**
 * Release 2D.1 calendar — genuine browser interaction (Chromium, production
 * build, desktop/SQLite server). The browser clock is pinned to
 * 2026-10-14T12:00Z so the calendar opens on October 2026.
 *
 * 1. Items land on the right day in several browser time zones.
 * 2. Month and week views, navigation, and the empty state.
 * 3. Drag → pending → Cancel sends nothing; Drag → Save persists.
 * 4. A failed save restores the confirmed date and offers Retry.
 * 5. Concurrent saves are prevented while one is in flight.
 * 6. Keyboard rescheduling via the Reschedule dialog; Escape cancels.
 * 7. Unscheduled panel: drag and keyboard scheduling.
 * 8. Loading error with a working Retry.
 * 9. The supported calendar's ends: the December 9999 and January 1900 month
 *    and week grids render, and Previous/Next stop at 1900-01-01 / 9999-12-31. * 10. Desktop project search beyond the 500-project filter cap (SQLite only).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Page, Request } from "playwright";
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

async function openCalendar(timezoneId?: string): Promise<Page> {
  const page = await newPage(timezoneId ? { timezoneId } : {});
  await page.clock.setFixedTime(NOW);
  await page.goto("/calendar", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "October 2026", level: 2 }).waitFor();
  await page.locator('li[data-day="2026-10-01"]').waitFor();
  return page;
}

async function openAt(now: string, heading: string): Promise<Page> {
  const page = await newPage({ timezoneId: "UTC" });
  await page.clock.setFixedTime(new Date(now));
  await page.goto("/calendar", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: heading, level: 2 }).waitFor();
  return page;
}

const cell = (page: Page, day: string) => page.locator(`li[data-day="${day}"]`);
const chip = (page: Page, key: string) => page.locator(`li[data-item="${key}"]`);

function patches(page: Page) {
  const seen: Request[] = [];
  page.on("request", (r) => {
    if (r.method() === "PATCH") seen.push(r);
  });
  return seen;
}

before(async () => {
  await start();
  seedPage = await newPage();
  const { project } = await api("/api/projects", "POST", {
    name: "Calendar E2E",
    source: "manual",
    type: "software",
    status: "active",
  });
  projectId = project.id;
  const task = async (title: string, dueDate?: string) =>
    (ids[title] = (await api(`/api/projects/${projectId}/tasks`, "POST", { title, ...(dueDate ? { dueDate } : {}) })).task.id);
  await task("Drag cancel me", "2026-10-05");
  await task("Drag save me", "2026-10-06");
  await task("Save fails", "2026-10-07");
  await task("Keyboard me", "2026-10-08");
  await task("Concurrent me", "2026-10-12");
  await task("Month end", "2026-10-31");
  await task("Park me");
  await task("Park me by keyboard");
  await task("End of time", "9999-12-31");
  await task("Start of time", "1900-01-01");
  ids["Milestone"] = (await api(`/api/projects/${projectId}/milestones`, "POST", { title: "Launch milestone", dueDate: "2026-10-20" })).milestone.id;
});

after(async () => stop());

describe("calendar (real browser)", () => {
  for (const tz of ["UTC", "America/Los_Angeles", "Pacific/Auckland"]) {
    it(`places date-only items on the right day in ${tz}`, async () => {
      const page = await openCalendar(tz);
      await cell(page, "2026-10-05").getByText("Drag cancel me").waitFor();
      await cell(page, "2026-10-20").getByText("Launch milestone").waitFor();
      await cell(page, "2026-10-31").getByText("Month end").waitFor();
      assert.equal(await cell(page, "2026-10-04").getByText("Drag cancel me").count(), 0);
      assert.equal(await cell(page, "2026-10-06").getByText("Drag cancel me").count(), 0);
      assert.match((await page.getByTestId("calendar-time-zone").textContent()) ?? "", new RegExp(tz.replace("/", "\\/")));
      // "Today" is the browser's date: still Oct 14 in LA, already Oct 15 in Auckland.
      const todayDay = tz === "Pacific/Auckland" ? "2026-10-15" : "2026-10-14";
      assert.match((await cell(page, todayDay).getAttribute("aria-label")) ?? "", /today/);
      assert.deepEqual(pageErrors(page), []);
    });
  }

  it("switches to week view, navigates, and shows the empty state", async () => {
    const page = await openCalendar("UTC");
    await page.getByRole("button", { name: "week", exact: true }).click();
    await page.getByRole("heading", { name: /Oct 12, 2026 – Oct 18, 2026/, level: 2 }).waitFor();
    // The heading changes immediately; the cells arrive with the new range.
    await cell(page, "2026-10-18").waitFor();
    assert.equal(await page.locator("li[data-day]").count(), 7);
    await cell(page, "2026-10-12").getByText("Concurrent me").waitFor();
    await page.getByRole("button", { name: "Next week" }).click();
    await page.getByRole("heading", { name: /Oct 19, 2026 – Oct 25, 2026/ }).waitFor();
    await cell(page, "2026-10-20").getByText("Launch milestone").waitFor();
    for (let i = 0; i < 6; i++) await page.getByRole("button", { name: "Next week" }).click();
    await page.getByText("Nothing scheduled in this range.").waitFor();
    await page.getByRole("button", { name: "Today" }).click();
    await page.getByRole("heading", { name: /Oct 12, 2026 – Oct 18, 2026/ }).waitFor();
  });

  it("drag shows a pending change; Cancel restores it and sends nothing", async () => {
    const page = await openCalendar();
    const sent = patches(page);
    await chip(page, `task:${ids["Drag cancel me"]}`).dragTo(cell(page, "2026-10-09"));
    const bar = page.getByRole("status").filter({ hasText: "Pending: move “Drag cancel me” from Oct 5, 2026 to Oct 9, 2026." });
    await bar.waitFor();
    await cell(page, "2026-10-09").locator('li[data-pending="true"]').getByText("Drag cancel me").waitFor();
    assert.equal(await cell(page, "2026-10-05").getByText("Drag cancel me").count(), 0);
    await bar.getByRole("button", { name: "Cancel" }).click();
    await cell(page, "2026-10-05").getByText("Drag cancel me").waitFor();
    assert.equal(sent.length, 0, "nothing persisted before Save");
    await page.reload();
    await cell(page, "2026-10-05").getByText("Drag cancel me").waitFor();
  });

  it("drag then Save persists through the task route", async () => {
    const page = await openCalendar();
    const sent = patches(page);
    // Hold the post-save refresh: the confirmed date must show without it.
    let hold = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    await page.route(/\/api\/calendar\?/, async (route) => {
      if (hold) await gate;
      await route.continue();
    });
    await chip(page, `task:${ids["Drag save me"]}`).dragTo(cell(page, "2026-10-16"));
    hold = true;
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Saved: “Drag save me” is now due Oct 16, 2026.").waitFor();
    await cell(page, "2026-10-16").locator(`li[data-item="task:${ids["Drag save me"]}"]:not([data-pending])`).waitFor();
    assert.equal(await cell(page, "2026-10-06").getByText("Drag save me").count(), 0, "never flashes back to the old day");
    hold = false;
    release();
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.url(), new RegExp(`/api/tasks/${ids["Drag save me"]}$`));
    assert.deepEqual(JSON.parse(sent[0]!.postData() ?? "{}"), { dueDate: "2026-10-16" });
    await page.reload();
    await cell(page, "2026-10-16").getByText("Drag save me").waitFor();
  });

  it("a failed save restores the confirmed date, explains why, and Retry succeeds", async () => {
    const page = await openCalendar();
    let fail = true;
    await page.route(`**/api/tasks/${ids["Save fails"]}`, async (route) => {
      if (fail && route.request().method() === "PATCH") {
        await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Database unavailable."}' });
      } else {
        await route.continue();
      }
    });
    await chip(page, `task:${ids["Save fails"]}`).dragTo(cell(page, "2026-10-22"));
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const alert = page.getByRole("alert").filter({ hasText: "Couldn’t reschedule “Save fails”: Database unavailable." });
    await alert.waitFor();
    assert.match((await alert.textContent()) ?? "", /still due Oct 7, 2026/);
    await cell(page, "2026-10-07").getByText("Save fails").waitFor();
    assert.equal(await cell(page, "2026-10-22").getByText("Save fails").count(), 0, "no optimistic lie");

    fail = false;
    await alert.getByRole("button", { name: "Retry" }).click();
    await cell(page, "2026-10-22").getByText("Save fails").waitFor();
    await page.getByText("Saved: “Save fails” is now due Oct 22, 2026.").waitFor();
  });

  it("prevents concurrent saves and freezes navigation while a save is in flight", async () => {
    const page = await openCalendar();
    const sent = patches(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    await page.route(`**/api/tasks/${ids["Concurrent me"]}`, async (route) => {
      await gate;
      await route.continue();
    });
    await chip(page, `task:${ids["Concurrent me"]}`).dragTo(cell(page, "2026-10-13"));
    const save = page.getByRole("button", { name: /^Sav/ });
    await save.click();
    await page.getByRole("button", { name: "Saving…" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Saving…" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Next month" }).isDisabled(), true);
    assert.equal(await page.getByLabel("Project", { exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Saving…" }).click({ force: true }).catch(() => {});
    release();
    await cell(page, "2026-10-13").getByText("Concurrent me").waitFor();
    await page.getByText(/Saved: “Concurrent me”/).waitFor();
    assert.equal(sent.length, 1, "exactly one PATCH");
  });

  it("reschedules with the keyboard only; Escape cancels and returns focus", async () => {
    const page = await openCalendar();
    const reschedule = page.getByRole("button", { name: "Reschedule Keyboard me" });
    await reschedule.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Reschedule “Keyboard me”" });
    await dialog.waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Reschedule Keyboard me");

    await page.keyboard.press("Enter");
    await dialog.waitFor();
    const input = dialog.getByLabel("Due date");
    assert.equal(await input.inputValue(), "2026-10-08");
    await input.fill("2026-10-27");
    await page.keyboard.press("Enter");
    await cell(page, "2026-10-27").getByText("Keyboard me").waitFor();
    await page.reload();
    await cell(page, "2026-10-27").getByText("Keyboard me").waitFor();
  });

  it("schedules unscheduled tasks by drag and by keyboard", async () => {
    const page = await openCalendar();
    const panel = page.getByRole("list", { name: "Unscheduled tasks" });
    await panel.getByText("Park me", { exact: true }).waitFor();
    await panel.locator("li").filter({ hasText: /^Park meCalendar E2E/ }).first().dragTo(cell(page, "2026-10-19"));
    await page.getByRole("status").filter({ hasText: "Pending: move “Park me” from no date to Oct 19, 2026." }).waitFor();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await cell(page, "2026-10-19").getByText("Park me", { exact: true }).waitFor();
    await panel.getByText("Park me", { exact: true }).waitFor({ state: "detached" });

    await page.getByRole("button", { name: "Schedule Park me by keyboard" }).click();
    const dialog = page.getByRole("dialog", { name: "Reschedule “Park me by keyboard”" });
    assert.equal(await dialog.getByLabel("Due date").inputValue(), "2026-10-14", "defaults to the browser's today");
    await dialog.getByLabel("Due date").fill("2026-10-23");
    await dialog.getByRole("button", { name: "Save" }).click();
    await cell(page, "2026-10-23").getByText("Park me by keyboard").waitFor();
    await page.getByText("Every task has a due date.").waitFor();
  });

  it("drags a milestone and saves it through the milestone route", async () => {
    const page = await openCalendar();
    const sent = patches(page);
    await chip(page, `milestone:${ids["Milestone"]}`).dragTo(cell(page, "2026-10-21"));
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await cell(page, "2026-10-21").getByText("Launch milestone").waitFor();
    assert.match(sent[0]!.url(), new RegExp(`/api/projects/${projectId}/milestones/${ids["Milestone"]}$`));
  });

  it("shows a loading error with a working Retry", async () => {
    const page = await newPage();
    await page.clock.setFixedTime(NOW);
    let fail = true;
    await page.route(/\/api\/calendar\?/, async (route) => {
      if (fail) await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' });
      else await route.continue();
    });
    await page.goto("/calendar");
    const alert = page.getByRole("alert").filter({ hasText: "Couldn’t load the calendar." });
    await alert.waitFor();
    fail = false;
    await alert.getByRole("button", { name: "Retry" }).click();
    await cell(page, "2026-10-05").getByText("Drag cancel me").waitFor();
  });

  it("December 9999: the grid ends on 9999-12-31 and Next stops there (month and week)", async () => {
    const page = await openAt("9999-12-15T12:00:00.000Z", "December 9999");
    await cell(page, "9999-12-31").getByText("End of time").waitFor();
    assert.equal(await page.locator("li[data-day]").count(), 33, "Mon 29 Nov … Fri 31 Dec 9999");
    assert.equal(await page.locator('li[data-day^="10000"]').count(), 0);
    assert.equal(await page.getByRole("button", { name: "Next month" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Previous month" }).isDisabled(), false);
    await page.getByLabel("Project", { exact: true }).locator("option", { hasText: "Calendar E2E" }).waitFor({ state: "attached" });
    assert.equal(await page.getByTestId("calendar-filter-truncated").count(), 0, "no truncation notice for a small workspace");

    await page.getByRole("button", { name: "week", exact: true }).click();
    await page.getByRole("heading", { name: "Dec 13, 9999 – Dec 19, 9999" }).waitFor();
    await page.getByRole("button", { name: "Next week" }).click();
    await page.getByRole("button", { name: "Next week" }).click();
    await page.getByRole("heading", { name: "Dec 27, 9999 – Dec 31, 9999" }).waitFor();
    await cell(page, "9999-12-31").getByText("End of time").waitFor();
    assert.equal(await page.locator("li[data-day]").count(), 5);
    assert.equal(await page.getByRole("button", { name: "Next week" }).isDisabled(), true);
    assert.deepEqual(pageErrors(page), []);
  });

  it("January 1900: the grid starts on 1900-01-01 and Previous stops there (month and week)", async () => {
    const page = await openAt("1900-01-15T12:00:00.000Z", "January 1900");
    await cell(page, "1900-01-01").getByText("Start of time").waitFor();
    assert.equal(await page.locator("li[data-day]").first().getAttribute("data-day"), "1900-01-01");
    assert.equal(await page.getByRole("button", { name: "Previous month" }).isDisabled(), true);
    await page.getByRole("button", { name: "Next month" }).click();
    await page.getByRole("heading", { name: "February 1900" }).waitFor();
    await page.getByRole("button", { name: "Previous month" }).click();
    await page.getByRole("heading", { name: "January 1900" }).waitFor();

    // Month navigation anchors on the 1st, so the week view opens on the first week.
    await page.getByRole("button", { name: "week", exact: true }).click();
    await page.getByRole("heading", { name: "Jan 1, 1900 – Jan 7, 1900" }).waitFor();
    await cell(page, "1900-01-01").getByText("Start of time").waitFor();
    assert.equal(await page.getByRole("button", { name: "Previous week" }).isDisabled(), true);
    await page.getByRole("button", { name: "Next week" }).click();
    await page.getByRole("heading", { name: "Jan 8, 1900 – Jan 14, 1900" }).waitFor();
    await page.getByRole("button", { name: "Previous week" }).click();
    await page.getByRole("heading", { name: "Jan 1, 1900 – Jan 7, 1900" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Previous week" }).isDisabled(), true);
    assert.deepEqual(pageErrors(page), []);
  });

  it("desktop: beyond 500 projects, search finds, selects and filters by a project sorted last", async () => {
    // Runs last: it grows the project list past the filter cap on the SQLite server.
    const { projects } = (await (await seedPage.request.get(`${baseURL}/api/calendar/filters`)).json()) as {
      projects: unknown[];
    };
    for (let i = projects.length; i <= 500; i++) {
      await api("/api/projects", "POST", {
        name: `Zeta project ${String(i).padStart(4, "0")}`,
        source: "manual",
        type: "software",
        status: "active",
      });
    }
    const last = (await api("/api/projects", "POST", {
      name: "Zeta project 9999",
      source: "manual",
      type: "software",
      status: "active",
    })) as { project: { id: string } };
    await api(`/api/projects/${last.project.id}/tasks`, "POST", { title: "Last project task", dueDate: "2026-10-26" });

    const page = await openCalendar("UTC");
    const notice = page.getByTestId("calendar-filter-truncated");
    await notice.getByText("The project list shows the first 500 projects (A–Z).", { exact: false }).waitFor();
    assert.equal(await page.getByTestId("filter-search-members").count(), 0, "desktop has no member concepts");
    assert.equal(await page.getByLabel("Assignee", { exact: true }).count(), 0);
    assert.equal(await page.getByLabel("Project", { exact: true }).locator("option", { hasText: "Zeta project 9999" }).count(), 0);

    const search = page.getByTestId("filter-search-projects");
    await search.getByLabel("Search projects").fill("zeta project 99");
    await search.getByRole("status").filter({ hasText: "1 match." }).waitFor();
    await search.getByRole("button", { name: "Zeta project 9999" }).click();
    assert.equal(await page.getByLabel("Project", { exact: true }).locator("option:checked").textContent(), "Zeta project 9999");
    await cell(page, "2026-10-26").getByText("Last project task").waitFor();
    assert.equal(await page.getByText("Drag cancel me").count(), 0, "filtered to the picked project");

    await search.getByLabel("Search projects").fill("no such project");
    await search.getByText("No projects match “no such project”.").waitFor();
    assert.deepEqual(pageErrors(page), []);
  });
});

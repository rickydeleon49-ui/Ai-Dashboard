/**
 * Release 2D.3 templates — genuine browser interaction (Chromium, production
 * build, desktop/SQLite server, no account).
 *
 * 1. Templates are reachable from navigation; the empty state.
 * 2. Build a template through the editor (milestone, tasks, subtask,
 *    dependency, checklist item, document) and save it.
 * 3. Validation errors (a dependency cycle) are shown and nothing is saved.
 * 4. Preview computes dates on the server and creates nothing.
 * 5. Creating the project navigates to it.
 * 6. A lost response is retried safely: one project, one request key.
 * 7. Narrow viewport; no console errors.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Page, Request } from "playwright";
import { baseURL, newPage, pageErrors, start, stop } from "./helpers";

let seedPage: Page;

async function projectsNamed(name: string): Promise<number> {
  const res = await seedPage.request.get(`${baseURL}/api/projects`);
  const { projects } = (await res.json()) as { projects: { name: string }[] };
  return projects.filter((p) => p.name === name).length;
}

async function openTemplates(): Promise<Page> {
  const page = await newPage({ timezoneId: "UTC" });
  await page.goto("/templates", { waitUntil: "domcontentloaded" });
  await page.getByTestId("template-list").waitFor();
  return page;
}

/** Creates a template through the API (for tests that don't exercise the editor). */
async function seedTemplate(name: string, body: Record<string, unknown> = {}): Promise<string> {
  const res = await seedPage.request.post(`${baseURL}/api/templates`, {
    data: {
      name,
      project: { name: `${name} project` },
      milestones: [{ key: "m1", title: "Kickoff", targetOffset: 3 }],
      tasks: [
        { key: "t1", title: "Plan", dueOffset: 2, milestoneKey: "m1" },
        { key: "t2", title: "Do", dueOffset: 5 },
      ],
      dependencies: [{ taskKey: "t2", dependsOnKey: "t1" }],
      ...body,
    },
  });
  assert.equal(res.status(), 201, await res.text());
  return ((await res.json()) as { template: { id: string } }).template.id;
}

before(async () => {
  await start();
  seedPage = await newPage();
});

after(async () => stop());

describe("templates (real browser)", () => {
  it("is reachable from navigation and shows an empty state first", async () => {
    const page = await newPage({ timezoneId: "UTC" });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: "Templates" }).first().click();
    await page.getByRole("heading", { name: "Templates", level: 1 }).waitFor();
    await page.getByTestId("template-empty").waitFor();
    assert.deepEqual(pageErrors(page), []);
  });

  it("builds and saves a template through the editor", async () => {
    const page = await openTemplates();
    await page.getByLabel("New template name").fill("Editor template");
    await page.getByRole("button", { name: "Create template" }).click();
    await page.getByTestId("template-editor").waitFor();
    assert.match((await page.getByTestId("template-mode").textContent()) ?? "", /Editing a template/);

    await page.getByRole("button", { name: "Add milestone" }).click();
    await page.getByLabel("Milestone 1 title").fill("Beta");
    await page.getByLabel("Target: days after start").fill("14");
    await page.getByRole("button", { name: "Add task" }).click();
    await page.getByLabel("Task 1 title").fill("Write spec");
    await page.getByTestId("task-row-0").getByLabel("Due: days after start").fill("2");
    await page.getByTestId("task-row-0").getByLabel("Milestone").selectOption({ label: "Beta" });
    await page.getByRole("button", { name: "Add task" }).click();
    await page.getByLabel("Task 2 title").fill("Review spec");
    await page.getByTestId("task-row-1").getByLabel("Subtask of").selectOption({ label: "Write spec" });
    await page.getByRole("button", { name: "Add task" }).click();
    await page.getByLabel("Task 3 title").fill("Build");
    await page.getByTestId("task-row-2").getByLabel("Due: days after start").fill("10");
    await page.getByRole("button", { name: "Add checklist item to Write spec" }).click();
    await page.getByLabel("Checklist item 1 for Write spec").fill("Success metrics");
    await page.getByRole("button", { name: "Add dependency" }).click();
    await page.getByLabel("Dependency 1: task").selectOption({ label: "Build" });
    await page.getByLabel("Dependency 1: depends on").selectOption({ label: "Write spec" });
    await page.getByRole("button", { name: "Add document" }).click();
    await page.getByLabel("Document 1 title").fill("Runbook");
    await page.getByLabel("Document 1 content").fill("Steps to launch.");
    // Deterministic ordering controls work from the keyboard too.
    await page.getByRole("button", { name: "Move task Build up" }).focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.getByLabel("Task 2 title").inputValue(), "Build");

    await page.getByRole("button", { name: "Save template" }).click();
    await page.getByRole("status").filter({ hasText: "Template saved." }).waitFor();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("template-editor").waitFor();
    assert.equal(await page.getByLabel("Task 1 title").inputValue(), "Write spec");
    assert.equal(await page.getByLabel("Task 2 title").inputValue(), "Build");
    assert.equal(await page.getByLabel("Checklist item 1 for Write spec").inputValue(), "Success metrics");
    assert.equal(await page.getByLabel("Document 1 content").inputValue(), "Steps to launch.");
    assert.deepEqual(pageErrors(page), []);
  });

  it("shows validation errors for a dependency cycle and saves nothing", async () => {
    const id = await seedTemplate("Cycle template");
    const page = await newPage({ timezoneId: "UTC" });
    await page.goto(`/templates/${id}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("template-editor").waitFor();
    await page.getByRole("button", { name: "Add dependency" }).click();
    await page.getByLabel("Dependency 2: task").selectOption({ label: "Plan" });
    await page.getByLabel("Dependency 2: depends on").selectOption({ label: "Do" });
    await page.getByRole("button", { name: "Save template" }).click();
    const issues = page.getByTestId("template-issues");
    await issues.waitFor();
    assert.match((await issues.textContent()) ?? "", /cycle/);
    const saved = (await (await seedPage.request.get(`${baseURL}/api/templates/${id}`)).json()) as { template: { dependencies: unknown[] } };
    assert.equal(saved.template.dependencies.length, 1, "the cycle was not saved");
  });

  it("previews on the server without creating anything, then creates the project", async () => {
    const id = await seedTemplate("Launch kit");
    const page = await newPage({ timezoneId: "Pacific/Auckland" });
    const failed: string[] = [];
    // Application requests only; Next.js cancels route prefetches when the page navigates.
    page.on("requestfailed", (r) => {
      if (r.url().includes("/api/")) failed.push(r.url());
    });
    page.on("response", (r) => {
      if (r.url().includes("/api/templates") && r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
    });
    await page.goto(`/templates/${id}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("template-apply").waitFor();
    await page.getByLabel("Project start date").fill("2028-02-27");
    await page.getByRole("button", { name: "Preview project" }).click();
    const preview = page.getByTestId("template-preview");
    await preview.waitFor();
    const text = (await preview.textContent()) ?? "";
    assert.match(text, /Preview only — nothing has been created yet/);
    assert.match(text, /Kickoff — 2028-03-01/, "leap-year arithmetic, whatever the browser zone");
    assert.match(text, /Plan — due 2028-02-29/);
    assert.match(text, /depends on Plan/);
    assert.equal(await projectsNamed("Launch kit project"), 0, "preview created nothing");

    await page.getByRole("button", { name: "Create project “Launch kit project”" }).click();
    await page.waitForURL(/\/projects\/[^/]+$/);
    await page.getByRole("heading", { name: "Launch kit project" }).first().waitFor();
    assert.equal(await projectsNamed("Launch kit project"), 1);
    assert.deepEqual(failed, []);
    assert.deepEqual(pageErrors(page), []);
  });

  it("retries a lost response safely: one project, one request key", async () => {
    const id = await seedTemplate("Retry kit");
    const page = await newPage({ timezoneId: "UTC" });
    const applyRequests: Request[] = [];
    let dropped = false;
    await page.route(/\/api\/templates\/[^/]+\/apply$/, async (route) => {
      applyRequests.push(route.request());
      if (!dropped) {
        dropped = true;
        // The server really creates the project; the browser never hears back.
        await route.fetch();
        return route.fulfill({ status: 502, body: "" });
      }
      return route.continue();
    });
    await page.goto(`/templates/${id}`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Project start date").fill("2028-05-01");
    await page.getByRole("button", { name: "Preview project" }).click();
    await page.getByTestId("template-preview").waitFor();
    await page.getByRole("button", { name: "Create project “Retry kit project”" }).click();
    await page.getByRole("alert").filter({ hasText: "Retrying is safe" }).waitFor();
    await page.getByRole("button", { name: "Retry creating project" }).click();
    await page.waitForURL(/\/projects\/[^/]+$/);
    assert.equal(applyRequests.length, 2);
    const keys = applyRequests.map((r) => (JSON.parse(r.postData() ?? "{}") as { idempotencyKey: string }).idempotencyKey);
    assert.equal(keys[0], keys[1], "the retry reused the request key");
    assert.equal(await projectsNamed("Retry kit project"), 1, "exactly one project");
  });

  it("stays usable on a narrow screen", async () => {
    const id = await seedTemplate("Narrow kit");
    const page = await newPage({ timezoneId: "UTC" });
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`/templates/${id}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("template-editor").waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `page overflows by ${overflow}px`);
    await page.getByLabel("Project start date").fill("2028-01-10");
    await page.getByRole("button", { name: "Preview project" }).click();
    await page.getByTestId("template-preview").waitFor();
    assert.deepEqual(pageErrors(page), []);
  });

  it("an unknown template shows a clear unavailable state", async () => {
    const page = await newPage({ timezoneId: "UTC" });
    await page.goto("/templates/tpl_does_not_exist", { waitUntil: "domcontentloaded" });
    await page.getByRole("alert").filter({ hasText: "isn’t available in your current workspace" }).waitFor();
  });
});

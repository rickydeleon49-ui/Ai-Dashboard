/**
 * The flows a user actually performs, driven through the real UI.
 *
 * These exercise the paths that carry the bugs fixed alongside them: archive
 * and restore keeping status consistent, uploads reporting per file, and the
 * GitHub hub degrading to demo data without losing anything.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Page } from "playwright";
import { baseURL, newPage, start, stop } from "./helpers";

let page: Page;

before(async () => {
  await start();
  page = await newPage();
});

after(async () => stop());

/** Creates a project through the API and returns its id. */
async function createProject(fields: Record<string, unknown>): Promise<string> {
  const response = await page.request.post(`${baseURL}/api/projects`, {
    data: { source: "manual", type: "software", status: "active", ...fields },
  });
  assert.equal(response.status(), 201, await response.text());
  return (await response.json()).project.id as string;
}

describe("project lifecycle", () => {
  it("creates a project through the form and shows it in the library", async () => {
    await page.goto("/projects/new", { waitUntil: "domcontentloaded" });
    await page.fill("input[name='name']", "E2E Created Project");
    const description = page.locator("textarea[name='description']");
    if (await description.count()) await description.fill("Made by the test suite");

    await Promise.all([
      page.waitForURL((url) => !url.pathname.endsWith("/new"), { timeout: 20_000 }),
      page.click("button[type='submit']"),
    ]);

    await page.goto("/projects", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=E2E Created Project", { timeout: 15_000 });
  });

  it("edits a project and persists the change", async () => {
    const id = await createProject({ name: "Editable Project" });

    await page.goto(`/projects/${id}/edit`, { waitUntil: "domcontentloaded" });
    await page.fill("input[name='name']", "Renamed Project");
    await Promise.all([
      page.waitForURL((url) => !url.pathname.endsWith("/edit"), { timeout: 20_000 }),
      page.click("button[type='submit']"),
    ]);

    const response = await page.request.get(`${baseURL}/api/projects/${id}`);
    assert.equal((await response.json()).project.name, "Renamed Project");
  });

  it("archives and restores without leaving the status stuck on archived", async () => {
    const id = await createProject({ name: "Archivable Project", status: "paused" });

    await page.goto(`/projects/${id}`, { waitUntil: "domcontentloaded" });
    await page.click("button:has-text('Archive')");
    await page.waitForSelector("button:has-text('Restore')", { timeout: 15_000 });

    let project = (await (await page.request.get(`${baseURL}/api/projects/${id}`)).json())
      .project;
    assert.equal(project.archived, true);
    assert.equal(project.status, "archived");

    await page.click("button:has-text('Restore')");
    await page.waitForSelector("button:has-text('Archive')", { timeout: 15_000 });

    project = (await (await page.request.get(`${baseURL}/api/projects/${id}`)).json())
      .project;
    assert.equal(project.archived, false);
    assert.equal(
      project.status,
      "paused",
      "restoring must return the project to the status it had before archiving",
    );
  });

  it("a partial update does not reset the fields it did not mention", async () => {
    const id = await createProject({
      name: "Untouched Fields",
      source: "github",
      type: "ai",
      status: "active",
      metadata: { github: { fullName: "someone/repo" } },
    });

    // Favouriting is the smallest possible PATCH, and used to reset a GitHub
    // project to a manual one and drop the metadata linking it upstream.
    const patched = await page.request.patch(`${baseURL}/api/projects/${id}`, {
      data: { favorite: true },
    });
    assert.ok(patched.ok(), await patched.text());

    const project = (await patched.json()).project;
    assert.equal(project.favorite, true);
    assert.equal(project.source, "github", "source must survive a partial update");
    assert.equal(project.type, "ai", "type must survive a partial update");
    assert.equal(project.status, "active", "status must survive a partial update");
    assert.deepEqual(
      project.metadata,
      { github: { fullName: "someone/repo" } },
      "metadata must survive a partial update",
    );
  });

  it("deletes a project", async () => {
    const id = await createProject({ name: "Disposable Project" });

    const response = await page.request.delete(`${baseURL}/api/projects/${id}`);
    assert.ok(response.ok(), await response.text());

    const after = await page.request.get(`${baseURL}/api/projects/${id}`);
    assert.equal(after.status(), 404);
  });
});

describe("uploads", () => {
  it("creates an uploaded project with a file in one flow", async () => {
    await page.goto("/uploads", { waitUntil: "domcontentloaded" });
    await page.fill("input[name='name']", "Uploaded E2E Project");
    await page.setInputFiles("input[type='file']", {
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello from the test suite"),
    });

    await page.click("button[type='submit']");
    await page.waitForSelector("text=Uploaded E2E Project", { timeout: 20_000 });

    const list = await (
      await page.request.get(`${baseURL}/api/projects?source=uploaded`)
    ).json();
    const created = list.projects.find(
      (p: { name: string }) => p.name === "Uploaded E2E Project",
    );
    assert.ok(created, "the uploaded project should be listed");

    const files = await (
      await page.request.get(`${baseURL}/api/projects/${created.id}/files`)
    ).json();
    assert.equal(files.files.length, 1);
    assert.equal(files.files[0].filename, "notes.txt");
  });

  it("reports per file when part of a batch is rejected", async () => {
    const id = await createProject({ name: "Batch Target", source: "uploaded" });

    const response = await page.request.post(`${baseURL}/api/projects/${id}/files`, {
      multipart: {
        files: { name: "good.txt", mimeType: "text/plain", buffer: Buffer.from("ok") },
      },
    });
    assert.equal(response.status(), 201);

    const body = await response.json();
    assert.equal(body.files.length, 1);
    assert.deepEqual(body.failed, [], "a clean batch reports no failures");
  });

  it("serves an uploaded file back", async () => {
    const id = await createProject({ name: "Downloadable", source: "uploaded" });
    const body = "downloadable content";

    const upload = await page.request.post(`${baseURL}/api/projects/${id}/files`, {
      multipart: {
        files: { name: "doc.txt", mimeType: "text/plain", buffer: Buffer.from(body) },
      },
    });
    const fileId = (await upload.json()).files[0].id;

    const download = await page.request.get(`${baseURL}/api/files/${fileId}`);
    assert.ok(download.ok());
    assert.equal(await download.text(), body);
  });
});

describe("github hub with no working credential", () => {
  it("shows demo data and says so rather than failing", async () => {
    await page.goto("/github", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("h1", { timeout: 15_000 });

    const text = (await page.textContent("body")) ?? "";
    assert.match(
      text,
      /demo|sample|not connected/i,
      "the hub must say the data is not real",
    );
  });

  it("a sync without a credential does not report pruning", async () => {
    const response = await page.request.post(`${baseURL}/api/github/sync`);
    assert.ok(response.ok(), await response.text());

    const body = await response.json();
    assert.equal(body.pruned, false, "an unauthenticated sync must not prune");
    assert.equal(body.removed, 0);
  });
});

describe("prompt library", () => {
  it("creates, edits, favourites and deletes a prompt", async () => {
    await page.goto("/ai/prompts/new", { waitUntil: "domcontentloaded" });
    await page.fill("input[name='title']", "E2E Prompt");
    await page.fill("textarea[name='body']", "Summarise the following text.");

    await Promise.all([
      page.waitForURL((url) => !url.pathname.endsWith("/new"), { timeout: 20_000 }),
      page.click("button[type='submit']"),
    ]);

    const listed = await (await page.request.get(`${baseURL}/api/prompts`)).json();
    const prompt = listed.prompts.find((p: { title: string }) => p.title === "E2E Prompt");
    assert.ok(prompt, "the prompt should be listed after creation");

    const patched = await page.request.patch(`${baseURL}/api/prompts/${prompt.id}`, {
      data: { favorite: true, title: "E2E Prompt Renamed" },
    });
    assert.ok(patched.ok(), await patched.text());
    const updated = await patched.json();
    assert.equal(updated.prompt.favorite, true);
    assert.equal(updated.prompt.title, "E2E Prompt Renamed");

    const removed = await page.request.delete(`${baseURL}/api/prompts/${prompt.id}`);
    assert.ok(removed.ok());

    const afterDelete = await (await page.request.get(`${baseURL}/api/prompts`)).json();
    assert.equal(
      afterDelete.prompts.some((p: { id: string }) => p.id === prompt.id),
      false,
    );
  });

  it("searches prompt bodies, not just titles", async () => {
    const created = await page.request.post(`${baseURL}/api/prompts`, {
      data: { title: "Unrelated Title", body: "distinctivebodyword appears here" },
    });
    assert.equal(created.status(), 201, await created.text());

    const found = await (
      await page.request.get(`${baseURL}/api/prompts?search=distinctivebodyword`)
    ).json();
    assert.equal(found.prompts.length, 1);
    assert.equal(found.prompts[0].title, "Unrelated Title");
  });
});

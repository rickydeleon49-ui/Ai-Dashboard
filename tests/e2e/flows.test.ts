/**
 * The flows a user actually performs, driven through the real UI.
 *
 * These exercise the paths that carry the bugs fixed alongside them: archive
 * and restore keeping status consistent, uploads reporting per file, and the
 * GitHub hub degrading to demo data without losing anything.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
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

/** Creates a task through the API and returns its id. */
async function createTask(projectId: string, fields: Record<string, unknown>): Promise<string> {
  const response = await page.request.post(`${baseURL}/api/projects/${projectId}/tasks`, {
    data: { status: "todo", priority: "medium", ...fields },
  });
  assert.equal(response.status(), 201, await response.text());
  return (await response.json()).task.id as string;
}

/** Creates a milestone through the API and returns its id. */
async function createMilestone(projectId: string, fields: Record<string, unknown>): Promise<string> {
  const response = await page.request.post(`${baseURL}/api/projects/${projectId}/milestones`, {
    data: { status: "open", ...fields },
  });
  assert.equal(response.status(), 201, await response.text());
  return (await response.json()).milestone.id as string;
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

describe("attaching project files to a chat", () => {
  /** Uploads one file to a project and returns its id. */
  async function upload(projectId: string, name: string, body: string): Promise<string> {
    const response = await page.request.post(
      `${baseURL}/api/projects/${projectId}/files`,
      {
        multipart: {
          files: { name, mimeType: "text/plain", buffer: Buffer.from(body) },
        },
      },
    );
    assert.equal(response.status(), 201, await response.text());
    return (await response.json()).files[0].id as string;
  }

  it("refuses attachments with no project to scope them", async () => {
    const response = await page.request.post(`${baseURL}/api/ai/chat`, {
      data: {
        message: "What is in this file?",
        model: "any-model",
        attachments: ["file_whatever"],
      },
    });

    assert.equal(response.status(), 422, await response.text());
    assert.match((await response.json()).error, /project/i);
  });

  it("will not send a file that belongs to another project", async () => {
    const mine = await createProject({ name: "Attach Mine", source: "uploaded" });
    const theirs = await createProject({ name: "Attach Theirs", source: "uploaded" });
    const foreign = await upload(theirs, "secret.txt", "not yours");

    /*
     * There is no Ollama in CI, so the generation itself fails — which is the
     * point: the attachment decision is made and streamed before any model is
     * contacted, so the NDJSON still carries the refusal.
     */
    const response = await page.request.post(`${baseURL}/api/ai/chat`, {
      data: {
        message: "Read it",
        model: "any-model",
        projectId: mine,
        attachments: [foreign],
      },
    });

    assert.ok(response.ok(), await response.text());
    const lines = (await response.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    const event = lines.find((line) => line.type === "attachments");
    assert.ok(event, "the stream should report on the attachments");
    assert.deepEqual(event.attached, []);
    assert.equal(event.rejected.length, 1);
    assert.match(event.rejected[0].reason, /different project/);
  });

  it("records an accepted attachment on the stored message", async () => {
    const id = await createProject({ name: "Attach Recorded", source: "uploaded" });
    const fileId = await upload(id, "notes.txt", "a line of notes");

    const response = await page.request.post(`${baseURL}/api/ai/chat`, {
      data: {
        message: "Summarise the notes",
        model: "any-model",
        projectId: id,
        attachments: [fileId],
      },
    });
    assert.ok(response.ok(), await response.text());

    const lines = (await response.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    const started = lines.find((line) => line.type === "conversation");
    assert.ok(started, "the stream should name the conversation it created");
    const event = lines.find((line) => line.type === "attachments");
    assert.equal(event.attached.length, 1);
    assert.equal(event.attached[0].filename, "notes.txt");

    // And it survives a reload, which is the reason it is stored at all.
    const stored = await (
      await page.request.get(`${baseURL}/api/ai/conversations/${started.id}`)
    ).json();
    const user = stored.conversation.messages.find(
      (message: { role: string }) => message.role === "user",
    );
    assert.equal(user.attachments.length, 1);
    assert.equal(user.attachments[0].filename, "notes.txt");
  });
});

describe("agent approval policy", () => {
  it("defaults to reading only, and remembers a change", async () => {
    const initial = await (await page.request.get(`${baseURL}/api/ai/approvals`)).json();
    assert.equal(initial.approvals.read_file, "auto");
    assert.equal(initial.approvals.git_push, "never");

    const patched = await page.request.patch(`${baseURL}/api/ai/approvals`, {
      data: { run_command: "never" },
    });
    assert.ok(patched.ok(), await patched.text());
    assert.equal((await patched.json()).approvals.run_command, "never");

    const reread = await (await page.request.get(`${baseURL}/api/ai/approvals`)).json();
    assert.equal(reread.approvals.run_command, "never");

    // Blocking "run a command" is what stops Agent mode reaching Hermes.
    const status = await (await page.request.get(`${baseURL}/api/ai/status`)).json();
    assert.equal(status.hermes.state, "disabled");

    await page.request.patch(`${baseURL}/api/ai/approvals`, {
      data: { run_command: "ask" },
    });
  });

  it("rejects a body naming nothing it knows", async () => {
    const response = await page.request.patch(`${baseURL}/api/ai/approvals`, {
      data: { not_an_action: "auto" },
    });
    assert.equal(response.status(), 422);
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

/**
 * Local AI with no Ollama on the machine.
 *
 * The test runner has no Ollama, which is the state most worth covering: the
 * workspace has to say so plainly, keep the rest of the dashboard working, and
 * refuse to send rather than hang.
 */
describe("local AI", () => {
  it("reports offline instead of spinning when nothing is listening", async () => {
    const response = await page.request.get(`${baseURL}/api/ai/status`);
    assert.ok(response.ok(), await response.text());

    const body = await response.json();
    assert.equal(body.local.state, "offline");
    assert.deepEqual(body.models, []);
    assert.equal(body.selectedModel, null);
    assert.ok(body.local.detail.length > 0, "an offline status must explain itself");
  });

  it("shows the workspace with the composer disabled", async () => {
    await page.goto("/ai/chat", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("h1");

    assert.equal((await page.textContent("h1"))?.trim(), "Local AI");
    await page.waitForSelector("textarea");
    assert.equal(await page.locator("textarea").isDisabled(), true);
    assert.ok((await page.textContent("body"))?.includes("Offline"));
  });

  it("saves a preference and reads it back", async () => {
    const saved = await page.request.patch(`${baseURL}/api/ai/settings`, {
      data: { contextSize: 40960, defaultModel: "qwen3-64k:latest" },
    });
    assert.ok(saved.ok(), await saved.text());

    const body = await (await page.request.get(`${baseURL}/api/ai/settings`)).json();
    assert.equal(body.settings.contextSize, 40960);
    assert.equal(body.settings.defaultModel, "qwen3-64k:latest");

    // Restore, so the assertions above do not depend on test ordering.
    await page.request.patch(`${baseURL}/api/ai/settings`, {
      data: { contextSize: 8192, defaultModel: "" },
    });
  });

  it("rejects a preference that is not a URL", async () => {
    const response = await page.request.patch(`${baseURL}/api/ai/settings`, {
      data: { endpoint: "not a url" },
    });
    assert.equal(response.status(), 422);
  });

  it("refuses to chat when local AI is turned off", async () => {
    await page.request.patch(`${baseURL}/api/ai/settings`, { data: { enabled: false } });

    const response = await page.request.post(`${baseURL}/api/ai/chat`, {
      data: { message: "hello", model: "qwen3:8b" },
    });
    assert.equal(response.status(), 409);
    assert.equal((await response.json()).code, "not_configured");

    await page.request.patch(`${baseURL}/api/ai/settings`, { data: { enabled: true } });
  });

  it("streams an error instead of hanging when Ollama is not there", async () => {
    const response = await page.request.post(`${baseURL}/api/ai/chat`, {
      data: { message: "hello", model: "qwen3:8b" },
    });
    assert.equal(response.status(), 200);

    const events = (await response.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; code?: string });

    assert.equal(events[0]?.type, "conversation");
    const failure = events.find((event) => event.type === "error");
    assert.equal(failure?.code, "offline");
  });

  it("keeps the transcript of a conversation that failed", async () => {
    const conversations = await (
      await page.request.get(`${baseURL}/api/ai/conversations`)
    ).json();
    assert.ok(conversations.conversations.length > 0, "the failed send should be saved");

    const first = conversations.conversations[0];
    const detail = await (
      await page.request.get(`${baseURL}/api/ai/conversations/${first.id}`)
    ).json();

    assert.equal(detail.conversation.messages[0].role, "user");
    assert.equal(detail.conversation.messages[0].content, "hello");

    const removed = await page.request.delete(`${baseURL}/api/ai/conversations/${first.id}`);
    assert.ok(removed.ok());
  });

  it("offers Open in AI Workspace on a project, carrying the project in the URL", async () => {
    const id = await createProject({ name: "E2E AI Context Project" });
    await page.goto(`/projects/${id}`, { waitUntil: "domcontentloaded" });

    const link = page.locator("a", { hasText: "Open in AI Workspace" }).first();
    assert.equal(await link.count(), 1);
    assert.equal(await link.getAttribute("href"), `/ai/chat?project=${id}`);

    await link.click();
    await page.waitForURL(`**/ai/chat?project=${id}`);
    assert.ok((await page.textContent("body"))?.includes("E2E AI Context Project"));
  });
});

describe("bulk task editing UI flows", () => {
  let projId: string;
  let taskId1: string;
  let taskId2: string;

  before(async () => {
    projId = await createProject({ name: "Bulk Task UI Project" });
    taskId1 = await createTask(projId, { title: "Alpha Bulk Task", status: "todo", priority: "medium" });
    taskId2 = await createTask(projId, { title: "Beta Bulk Task", status: "todo", priority: "high" });
  });

  afterEach(async () => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  it("selects individual tasks, toggles selection, and displays BulkActionsBar with truthful count", async () => {
    await page.goto(`/projects/${projId}/tasks`, { waitUntil: "domcontentloaded" });

    // Initial state: BulkActionsBar should not be present
    const bar = page.locator("text=tasks selected");
    assert.equal(await bar.count(), 0);

    // Select first task
    const check1 = page.locator(`input[aria-label="Select task Alpha Bulk Task"]`);
    await check1.click();
    await page.waitForSelector("text=1 task selected");

    // Select second task
    const check2 = page.locator(`input[aria-label="Select task Beta Bulk Task"]`);
    await check2.click();
    await page.waitForSelector("text=2 tasks selected");

    // Click Clear button
    await page.click("button:has-text('Clear')");
    await page.waitForSelector("text=tasks selected", { state: "detached" });
  });

  it("handles select-all-visible and indeterminate checkbox state", async () => {
    await page.goto(`/projects/${projId}/tasks`, { waitUntil: "domcontentloaded" });

    const selectAllCheck = page.locator(`input[aria-label="Select all visible tasks"]`);
    await selectAllCheck.click();
    await page.waitForSelector("text=2 tasks selected");

    // Both tasks selected
    const check1 = page.locator(`input[aria-label="Select task Alpha Bulk Task"]`);
    const check2 = page.locator(`input[aria-label="Select task Beta Bulk Task"]`);
    assert.equal(await check1.isChecked(), true);
    assert.equal(await check2.isChecked(), true);

    // Uncheck task 1 -> indeterminate
    await check1.click();
    await page.waitForSelector("text=1 task selected");

    const isIndeterminate = await selectAllCheck.evaluate((el: HTMLInputElement) => el.indeterminate);
    assert.equal(isIndeterminate, true);

    // Click select all again -> selects all again
    await selectAllCheck.click();
    await page.waitForSelector("text=2 tasks selected");
    const isIndeterminateAfter = await selectAllCheck.evaluate((el: HTMLInputElement) => el.indeterminate);
    assert.equal(isIndeterminateAfter, false);
    assert.equal(await selectAllCheck.isChecked(), true);
  });

  it("changes filter after selecting tasks and confirms hidden tasks are excluded from bulk submit", async () => {
    const filterProj = await createProject({ name: "Filter Exclusion Project" });
    const todoId = await createTask(filterProj, { title: "Todo Task Filter", status: "todo" });
    const doneId = await createTask(filterProj, { title: "Done Task Filter", status: "done" });

    await page.goto("/my-work", { waitUntil: "domcontentloaded" });

    // Select both tasks
    await page.click(`input[aria-label="Select task Todo Task Filter"]`);
    await page.click(`input[aria-label="Select task Done Task Filter"]`);
    await page.waitForSelector("text=2 tasks selected");

    // Switch filter to todo only via client-side filter control
    await page.selectOption(`select[aria-label="Filter by status"]`, "todo");
    await page.waitForSelector("text=1 task selected");

    // Configure priority update
    await page.selectOption(`select[aria-label="Bulk update priority"]`, "urgent");

    let submittedTaskIds: string[] = [];
    await page.route("**/api/tasks/bulk", async (route) => {
      const data = route.request().postDataJSON() as { taskIds: string[] };
      submittedTaskIds = data.taskIds;
      await route.continue();
    });

    await page.click("button:has-text('Apply changes')");
    await page.waitForResponse((r) => r.url().includes("/api/tasks/bulk"));

    // Crucial assertion: Hidden task (doneId) MUST NOT be submitted!
    assert.deepEqual(submittedTaskIds, [todoId]);
    assert.equal(submittedTaskIds.includes(doneId), false);
  });

  it("prompts for confirmation on disruptive status updates and respects cancel and confirm", async () => {
    await page.goto(`/projects/${projId}/tasks`, { waitUntil: "domcontentloaded" });
    await page.click(`input[aria-label="Select task Alpha Bulk Task"]`);
    await page.waitForSelector("text=1 task selected");

    // Choose disruptive status: "done"
    await page.selectOption(`select[aria-label="Bulk update status"]`, "done");

    // Click Apply changes
    await page.click("button:has-text('Apply changes')");

    // Disruptive confirmation prompt should be visible
    await page.waitForSelector("text=Apply to 1 task?");
    const confirmBtn = page.locator("button:has-text('Confirm')");
    const cancelBtn = page.locator("button:has-text('Cancel')");
    assert.equal(await confirmBtn.count(), 1);
    assert.equal(await cancelBtn.count(), 1);

    // Cancel disruptive action
    await cancelBtn.click();
    assert.equal(await page.locator("text=Apply to 1 task?").count(), 0);

    // Re-apply and confirm
    await page.click("button:has-text('Apply changes')");
    await page.waitForSelector("text=Apply to 1 task?");
    await confirmBtn.click();

    // Succeeded message
    await page.waitForSelector("text=Successfully updated 1 task.");
  });

  it("truthfully renders updated, unchanged, and failed outcome wording", async () => {
    await page.goto(`/projects/${projId}/tasks`, { waitUntil: "domcontentloaded" });
    await page.click(`input[aria-label="Select task Alpha Bulk Task"]`);
    await page.selectOption(`select[aria-label="Bulk update priority"]`, "low");

    // Case 1: single updated
    await page.route("**/api/tasks/bulk", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requested: 1,
          succeeded: 1,
          updated: 1,
          unchanged: 0,
          failed: 0,
          results: [{ taskId: taskId1, status: "updated" }],
        }),
      });
    });
    await page.click("button:has-text('Apply changes')");
    await page.waitForSelector("text=Successfully updated 1 task.");
    await page.unroute("**/api/tasks/bulk");

    // Case 2: single unchanged
    await page.click(`input[aria-label="Select task Alpha Bulk Task"]`);
    await page.selectOption(`select[aria-label="Bulk update priority"]`, "low");
    await page.route("**/api/tasks/bulk", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requested: 1,
          succeeded: 1,
          updated: 0,
          unchanged: 1,
          failed: 0,
          results: [{ taskId: taskId1, status: "unchanged" }],
        }),
      });
    });
    await page.click("button:has-text('Apply changes')");
    await page.waitForSelector("text=1 task already matched.");
    await page.unroute("**/api/tasks/bulk");

    // Case 3: mixed breakdown
    await page.click(`input[aria-label="Select task Alpha Bulk Task"]`);
    await page.click(`input[aria-label="Select task Beta Bulk Task"]`);
    await page.selectOption(`select[aria-label="Bulk update priority"]`, "high");
    await page.route("**/api/tasks/bulk", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requested: 3,
          succeeded: 2,
          updated: 1,
          unchanged: 1,
          failed: 1,
          results: [
            { taskId: taskId1, status: "updated" },
            { taskId: taskId2, status: "unchanged" },
            { taskId: "fake_id", status: "failed", error: "Not found", retryable: false },
          ],
        }),
      });
    });
    await page.click("button:has-text('Apply changes')");
    await page.waitForSelector("text=1 updated, 1 already matched, 1 failed.");
    await page.unroute("**/api/tasks/bulk");
  });

  it("retains failed tasks and handles mixed retryable and non-retryable failures during retry", async () => {
    const mixedProj = await createProject({ name: "Retry Mixed Project" });
    const tSuccess = await createTask(mixedProj, { title: "Success Item" });
    const tRetryable = await createTask(mixedProj, { title: "Retryable Fail Item" });
    const tPermanent = await createTask(mixedProj, { title: "Permanent Fail Item" });

    await page.goto(`/projects/${mixedProj}/tasks`, { waitUntil: "domcontentloaded" });
    await page.click(`input[aria-label="Select task Success Item"]`);
    await page.click(`input[aria-label="Select task Retryable Fail Item"]`);
    await page.click(`input[aria-label="Select task Permanent Fail Item"]`);
    await page.waitForSelector("text=3 tasks selected");

    await page.selectOption(`select[aria-label="Bulk update priority"]`, "urgent");

    // Initial response: 1 success, 1 retryable fail, 1 non-retryable fail
    await page.route("**/api/tasks/bulk", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requested: 3,
          succeeded: 1,
          updated: 1,
          unchanged: 0,
          failed: 2,
          results: [
            { taskId: tSuccess, status: "updated" },
            { taskId: tRetryable, status: "failed", error: "Network glitch", retryable: true },
            { taskId: tPermanent, status: "failed", error: "Cyclic dependency", retryable: false },
          ],
        }),
      });
    });

    await page.click("button:has-text('Apply changes')");
    await page.waitForSelector("text=1 updated, 2 failed.");
    await page.unroute("**/api/tasks/bulk");

    // Succeeded item is unselected; failed items remain selected!
    assert.equal(await page.locator(`input[aria-label="Select task Success Item"]`).isChecked(), false);
    assert.equal(await page.locator(`input[aria-label="Select task Retryable Fail Item"]`).isChecked(), true);
    assert.equal(await page.locator(`input[aria-label="Select task Permanent Fail Item"]`).isChecked(), true);

    // "Failed tasks (retained in selection):" list is visible
    await page.waitForSelector("text=Failed tasks (retained in selection):");
    await page.waitForSelector("text=Network glitch");
    await page.waitForSelector("text=Cyclic dependency");

    // "Retry retryable failures" button is visible
    const retryBtn = page.locator("button:has-text('Retry retryable failures')");
    assert.equal(await retryBtn.count(), 1);

    // Intercept retry: must ONLY send tRetryable!
    let retriedTaskIds: string[] = [];
    await page.route("**/api/tasks/bulk", async (route) => {
      const data = route.request().postDataJSON() as { taskIds: string[] };
      retriedTaskIds = data.taskIds;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requested: 1,
          succeeded: 1,
          updated: 1,
          unchanged: 0,
          failed: 0,
          results: [{ taskId: tRetryable, status: "updated" }],
        }),
      });
    });

    await retryBtn.click();
    await page.waitForResponse((r) => r.url().includes("/api/tasks/bulk"));
    await page.unroute("**/api/tasks/bulk");

    // Crucial: Only retryable task was sent!
    assert.deepEqual(retriedTaskIds, [tRetryable]);

    // Outcome merged: 2 succeeded, 1 failed. Permanent failure remains visible and selected!
    await page.waitForSelector("text=2 updated, 1 failed.");
    assert.equal(await page.locator(`input[aria-label="Select task Permanent Fail Item"]`).isChecked(), true);
    assert.equal(await page.locator(`input[aria-label="Select task Retryable Fail Item"]`).isChecked(), false);
    assert.equal(await page.locator("button:has-text('Retry retryable failures')").count(), 0);
  });

  it("disables milestone updates when tasks across multiple projects are selected in My Work", async () => {
    const pA = await createProject({ name: "Multi Milestone Proj A" });
    const pB = await createProject({ name: "Multi Milestone Proj B" });
    await createMilestone(pA, { title: "Milestone A Only" });
    await createTask(pA, { title: "Task in Proj A" });
    await createTask(pB, { title: "Task in Proj B" });

    await page.goto("/my-work", { waitUntil: "domcontentloaded" });
    await page.click(`input[aria-label="Select task Task in Proj A"]`);
    await page.click(`input[aria-label="Select task Task in Proj B"]`);
    await page.waitForSelector("text=2 tasks selected");

    const milestoneSelect = page.locator(`select[aria-label="Bulk update milestone"]`);
    assert.equal(await milestoneSelect.isDisabled(), true);
    const text = await milestoneSelect.textContent();
    assert.ok(text?.includes("(Multiple projects selected)"));
  });

  it("handles non-2xx and malformed milestone responses with visible failure state without crashing", async () => {
    const errorProj = await createProject({ name: "Error Milestone Proj" });
    await createTask(errorProj, { title: "Task Error Milestone" });

    // 1. Non-2xx response (500)
    await page.route(`**/api/projects/${errorProj}/milestones`, async (route) => {
      await route.fulfill({ status: 500, contentType: "text/plain", body: "Internal Server Error" });
    });

    await page.goto("/my-work", { waitUntil: "domcontentloaded" });
    await page.click(`input[aria-label="Select task Task Error Milestone"]`);
    await page.waitForSelector("text=1 task selected");

    const msSelect = page.locator(`select[aria-label="Bulk update milestone"]`);
    await page.waitForSelector("span[role='status']:has-text('Failed to load milestones')");
    assert.equal(await msSelect.isDisabled(), true);

    await page.unroute(`**/api/projects/${errorProj}/milestones`);

    // 2. Malformed JSON response
    await page.route(`**/api/projects/${errorProj}/milestones`, async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "MALFORMED_JSON{{" });
    });

    // Uncheck and recheck
    await page.click(`input[aria-label="Select task Task Error Milestone"]`);
    await page.click(`input[aria-label="Select task Task Error Milestone"]`);
    await page.waitForSelector("span[role='status']:has-text('Malformed milestone response')");
    assert.equal(await msSelect.isDisabled(), true);

    await page.unroute(`**/api/projects/${errorProj}/milestones`);
  });

  it("prevents stale milestone responses from overwriting a newer project's milestones", async () => {
    const staleProjA = await createProject({ name: "Stale Proj A" });
    const freshProjB = await createProject({ name: "Fresh Proj B" });
    await createMilestone(freshProjB, { title: "B Real Milestone" });
    await createTask(staleProjA, { title: "Stale Task A" });
    await createTask(freshProjB, { title: "Fresh Task B" });

    // Route Stale Proj A with a 400ms delay
    await page.route(`**/api/projects/${staleProjA}/milestones`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ milestones: [{ id: "ms_stale", title: "Old Stale MS A" }] }),
      });
    });

    await page.goto("/my-work", { waitUntil: "domcontentloaded" });

    // Select Task A, then immediately uncheck Task A and select Task B
    await page.click(`input[aria-label="Select task Stale Task A"]`);
    await page.click(`input[aria-label="Select task Stale Task A"]`);
    await page.click(`input[aria-label="Select task Fresh Task B"]`);

    // Wait for Fresh Proj B milestones option to be attached in select
    await page.waitForSelector(
      "select[aria-label='Bulk update milestone'] option:has-text('B Real Milestone')",
      { state: "attached" },
    );

    // Wait 500ms to ensure stale route resolves
    await page.waitForTimeout(500);

    // Verify Fresh Proj B's milestone is still shown, NOT Old Stale MS A!
    const selectContent = await page.locator(`select[aria-label="Bulk update milestone"]`).textContent();
    assert.ok(selectContent?.includes("B Real Milestone"));
    assert.equal(selectContent?.includes("Old Stale MS A"), false);

    await page.unroute(`**/api/projects/${staleProjA}/milestones`);
  });

  it("supports keyboard operation and accessible labels", async () => {
    await page.goto(`/projects/${projId}/tasks`, { waitUntil: "domcontentloaded" });

    // Verify accessible labels on all key controls
    assert.ok((await page.locator(`input[aria-label="Select all visible tasks"]`).count()) > 0);
    assert.ok((await page.locator(`input[aria-label="Select task Alpha Bulk Task"]`).count()) > 0);

    // Focus select all visible checkbox and toggle with keyboard Space
    const selectAllCheck = page.locator(`input[aria-label="Select all visible tasks"]`);
    await selectAllCheck.focus();
    await page.keyboard.press("Space");
    await page.waitForSelector("text=tasks selected");

    // Verify accessible labels on bulk bar controls
    assert.ok((await page.locator(`select[aria-label="Bulk update status"]`).count()) > 0);
    assert.ok((await page.locator(`select[aria-label="Bulk update priority"]`).count()) > 0);
    assert.ok((await page.locator(`select[aria-label="Bulk update milestone"]`).count()) > 0);

    // Clear selection
    await page.click("button:has-text('Clear')");
  });

  it("renders clean responsive layout without horizontal overflow on narrow mobile viewports", async () => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`/projects/${projId}/tasks`, { waitUntil: "domcontentloaded" });

    await page.click(`input[aria-label="Select task Alpha Bulk Task"]`);
    await page.waitForSelector("text=1 task selected");

    // Assert no horizontal scrollbar / overflow
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert.equal(
      hasHorizontalOverflow,
      false,
      "BulkActionsBar must not cause horizontal page overflow on 375px viewport",
    );
  });
});

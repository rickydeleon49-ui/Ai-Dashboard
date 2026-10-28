/**
 * Release 2E.1 — Safe Markdown in a real browser (Chromium, production build,
 * desktop/SQLite server, no account).
 *
 * 1. Write → Preview → Write by keyboard keeps unsaved text; save; read the
 *    document page; reopen the editor with the exact source.
 * 2. Save failures are announced and never lose the text.
 * 3. Every stored-XSS payload renders inert: no element, attribute or URL
 *    beyond the allowlist, nothing executes, no dialog, no request leaves the
 *    app's origin.
 * 4. Images never load; alt text is shown instead.
 * 5. External links open a new, opener-less, referrer-less window; refused
 *    links have no destination at all.
 * 6. Existing plain-text documents and template-created documents render.
 * 7. Long URLs, wide tables and long code never widen the page at phone width.
 * 8. Search through the page matches visible text, not destinations.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Page } from "playwright";
import { baseURL, newPage, pageErrors, start, stop, waitForHydration } from "./helpers";
import { STORED_XSS_PAYLOADS } from "../helpers/markdown-fixtures";
import { assertInertDom, inspectRendered, watch as watchOrigin } from "./markdown-dom";

const watch = (page: Page) => watchOrigin(page, new URL(baseURL).origin);

let seedPage: Page;
let projectId = "";

const NL = String.fromCharCode(10);
const lines = (...parts: string[]) => parts.join(NL);

async function createProject(name: string): Promise<string> {
  const res = await seedPage.request.post(`${baseURL}/api/projects`, { data: { name } });
  assert.equal(res.status(), 201, await res.text());
  return ((await res.json()) as { project: { id: string } }).project.id;
}

async function createDocument(title: string, content: string, inProject = projectId): Promise<string> {
  const res = await seedPage.request.post(`${baseURL}/api/projects/${inProject}/knowledge`, {
    data: { title, content },
  });
  assert.equal(res.status(), 201, await res.text());
  return ((await res.json()) as { document: { id: string } }).document.id;
}

before(async () => {
  await start();
  seedPage = await newPage();
  projectId = await createProject("Markdown project");
});

after(async () => stop());

describe("knowledge Markdown (real browser)", () => {
  it("writes, previews by keyboard, saves, reads and reopens a document without losing text", async () => {
    const page = await newPage();
    const watched = watch(page);
    await page.goto(`/projects/${projectId}/knowledge/new`, { waitUntil: "domcontentloaded" });
    await waitForHydration(page.getByLabel("Content", { exact: true }));
    await page.getByLabel("Title", { exact: true }).fill("Runbook");

    const source = lines(
      "# Deploy",
      "",
      "Run **carefully** with `npm run deploy`.",
      "",
      "- [x] Tag",
      "- [ ] Announce",
      "",
      "| Step | Owner |",
      "| ---- | ----- |",
      "| Ship | Ana   |",
      "",
      "```sh",
      "./deploy --prod",
      "```",
      "",
      "[Docs](https://example.com/docs) and [project](/projects)",
    );
    const textarea = page.getByLabel("Content", { exact: true });
    await textarea.fill(source);

    const writeTab = page.getByRole("tab", { name: "Write" });
    const previewTab = page.getByRole("tab", { name: "Preview" });
    assert.equal(await writeTab.getAttribute("aria-selected"), "true");
    await writeTab.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await previewTab.getAttribute("aria-selected"), "true");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("role")), "tab");

    const preview = page.getByRole("tabpanel", { name: "Preview" });
    await preview.getByRole("heading", { name: "Deploy", level: 2 }).waitFor();
    assert.equal(await preview.locator("table td", { hasText: "Ana" }).count(), 1);
    assert.equal(await preview.locator('input[type="checkbox"]:checked').count(), 1);
    assert.equal(await preview.locator("pre code").textContent(), `./deploy --prod${NL}`);
    assert.equal(await textarea.isVisible(), false, "the textarea is hidden in Preview");

    await page.keyboard.press("ArrowLeft");
    assert.equal(await writeTab.getAttribute("aria-selected"), "true");
    assert.equal(await textarea.inputValue(), source, "switching tabs kept the unsaved text");

    await page.getByRole("button", { name: "Save document" }).click();
    await page.waitForURL(`**/projects/${projectId}/knowledge`);
    await page.getByRole("link", { name: "Runbook" }).click();
    await page.waitForURL(/\/knowledge\/[^/]+$/);
    await page.getByRole("heading", { name: "Runbook", level: 1 }).waitFor();
    await page.getByRole("heading", { name: "Deploy", level: 2 }).waitFor();
    const rendered = await inspectRendered(page);
    assertInertDom(rendered, "saved document");
    assert.deepEqual(
      rendered.links.map((l) => [l.text, l.href, l.target, l.rel]),
      [
        ["Docs", "https://example.com/docs", "_blank", "noopener noreferrer nofollow ugc"],
        ["project", "/projects", null, null],
      ],
    );

    await page.getByRole("link", { name: "Edit" }).click();
    await page.getByLabel("Content", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Content", { exact: true }).inputValue(), source, "the exact source reopens in the editor");
    assert.deepEqual(watched.dialogs, []);
    assert.deepEqual(watched.foreignRequests, []);
    assert.deepEqual(pageErrors(page), []);
  });

  it("announces save failures and keeps the text", async () => {
    const id = await createDocument("Failing save", "original");
    const page = await newPage();
    await page.goto(`/projects/${projectId}/knowledge/${id}/edit`, { waitUntil: "domcontentloaded" });
    await waitForHydration(page.getByLabel("Content", { exact: true }));
    await page.getByLabel("Content", { exact: true }).fill("# Unsaved work");

    await page.route(`**/api/projects/${projectId}/knowledge/${id}`, (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 500, contentType: "text/html", body: "<h1>Internal Server Error</h1>" })
        : route.continue(),
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    const alert = page.getByRole("alert").filter({ hasText: "Could not save" });
    await alert.waitFor();
    assert.match((await alert.textContent()) ?? "", /error 500.*still here/);
    assert.equal(await page.getByLabel("Content", { exact: true }).inputValue(), "# Unsaved work");

    await page.unroute(`**/api/projects/${projectId}/knowledge/${id}`);
    await page.route(`**/api/projects/${projectId}/knowledge/${id}`, (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Forbidden: viewer" }) })
        : route.continue(),
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByRole("alert").filter({ hasText: "Forbidden: viewer" }).waitFor();
    assert.equal(await page.getByLabel("Content", { exact: true }).inputValue(), "# Unsaved work");
  });

  it("renders every stored-XSS payload inert: nothing executes, nothing is requested", async () => {
    const page = await newPage();
    const watched = watch(page);
    for (const [name, payload] of Object.entries(STORED_XSS_PAYLOADS)) {
      const id = await createDocument(`XSS ${name}`, payload);
      await page.goto(`/projects/${projectId}/knowledge/${id}`, { waitUntil: "load" });
      await page.locator("[data-markdown-view]").first().waitFor();
      assertInertDom(await inspectRendered(page), name);
    }
    // The list page renders the same documents as summaries, and expanded.
    await page.goto(`/projects/${projectId}/knowledge?search=xss`, { waitUntil: "load" });
    const showFull = page.getByRole("button", { name: "Show full" });
    await waitForHydration(showFull.first());
    // Each click renames that button to "Collapse", so always take the first left.
    while ((await showFull.count()) > 0) await showFull.first().click();
    assertInertDom(await inspectRendered(page), "expanded list cards");
    await page.waitForTimeout(500);
    assert.deepEqual(watched.dialogs, []);
    assert.deepEqual(watched.foreignRequests, []);
    assert.deepEqual(pageErrors(page), []);
  });

  it("the DOM inspector itself catches active content (canary for the checks above)", async () => {
    const id = await createDocument("Canary", "plain words");
    const page = await newPage();
    await page.goto(`/projects/${projectId}/knowledge/${id}`, { waitUntil: "load" });
    // Injected before hydration, the node is discarded when React reconciles.
    await waitForHydration(page.locator("[data-markdown-view]").first());
    // Inject what the renderer must never produce, and let it run.
    await page.evaluate(() => {
      const root = document.querySelector("[data-markdown-view]")!;
      const img = document.createElement("img");
      img.setAttribute("src", "/canary-missing.png");
      img.setAttribute("onerror", "window.__xss = 'canary'");
      root.appendChild(img);
    });
    await page.waitForFunction(() => (window as unknown as { __xss?: unknown }).__xss === "canary");
    const result = await inspectRendered(page);
    assert.equal(result.forbidden.length, 1);
    assert.deepEqual(result.eventAttributes, ["IMG[onerror]"]);
    assert.deepEqual(result.urlAttributes, ["IMG[src]"]);
    assert.equal(result.xss, "canary");
    assert.throws(() => assertInertDom(result, "canary"));
  });

  it("shows alt text in place of images and never requests them", async () => {
    const id = await createDocument(
      "Images",
      lines("![Architecture diagram](https://tracker.example/pixel.png?u=1)", "", "![](https://tracker.example/blank.png)"),
    );
    const page = await newPage();
    const watched = watch(page);
    await page.goto(`/projects/${projectId}/knowledge/${id}`, { waitUntil: "load" });
    const placeholders = page.locator('[data-markdown-image="blocked"]');
    assert.deepEqual(await placeholders.allTextContents(), ["[Image: Architecture diagram]", "[Image: image]"]);
    assert.equal(await page.getByRole("img", { name: "Image not loaded: Architecture diagram" }).count(), 1);
    assert.equal(await page.locator("img").count(), 0);
    await page.waitForTimeout(300);
    assert.deepEqual(watched.foreignRequests, []);
  });

  it("opens external links in a new window with no opener or referrer, and refused links go nowhere", async () => {
    const id = await createDocument(
      "Links",
      lines("[External](https://external.example/page)", "", "[Refused](javascript:window.__xss=1)", "", "[Proto](//evil.example)"),
    );
    const page = await newPage();
    // Answer the external site locally: the test must never reach the internet.
    await page.context().route("https://external.example/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<title>external</title>" }),
    );
    await page.goto(`/projects/${projectId}/knowledge/${id}`, { waitUntil: "domcontentloaded" });
    const before = page.url();

    const [popup] = await Promise.all([page.waitForEvent("popup"), page.getByRole("link", { name: "External" }).click()]);
    await popup.waitForLoadState("domcontentloaded");
    assert.equal(popup.url(), "https://external.example/page");
    assert.equal(await popup.evaluate(() => window.opener), null, "the new window cannot reach back");
    assert.equal(await popup.evaluate(() => document.referrer), "", "the document's URL is not leaked");
    await popup.close();
    assert.equal(page.url(), before);

    for (const name of ["Refused", "Proto"]) {
      const refused = page.locator('[data-markdown-link="refused"]', { hasText: name });
      assert.equal(await refused.count(), 1);
      assert.equal(await refused.getAttribute("href"), null);
      await refused.click();
    }
    assert.equal(page.url(), before);
    assert.equal(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss ?? null), null);
  });

  it("renders existing plain-text and template-created documents, and empty ones", async () => {
    const plain = await createDocument("Legacy note", lines("Line one of a plain note", "line two", "", "A second paragraph."));
    const empty = await createDocument("Empty doc", "");

    const template = await seedPage.request.post(`${baseURL}/api/templates`, {
      data: {
        name: "Markdown template",
        project: { name: "From template" },
        documents: [{ title: "Template runbook", content: lines("# Checklist", "", "- [ ] First step", "- [x] Done step"), category: null, pinned: false }],
      },
    });
    assert.equal(template.status(), 201, await template.text());
    const templateId = ((await template.json()) as { template: { id: string } }).template.id;
    const applied = await seedPage.request.post(`${baseURL}/api/templates/${templateId}/apply`, {
      data: { idempotencyKey: "markdown-e2e-template-key", startDate: "2028-02-27" },
    });
    assert.equal(applied.status(), 201, await applied.text());
    const createdProject = ((await applied.json()) as { project: { id: string } }).project.id;

    const page = await newPage();
    await page.goto(`/projects/${projectId}/knowledge/${plain}`, { waitUntil: "domcontentloaded" });
    // innerText reflects what is displayed: the plain note keeps its line break.
    const paragraphs = await page.locator("[data-markdown-view] p").allInnerTexts();
    assert.deepEqual(paragraphs, [`Line one of a plain note${NL}line two`, "A second paragraph."]);

    await page.goto(`/projects/${projectId}/knowledge/${empty}`, { waitUntil: "domcontentloaded" });
    await page.getByText("No content yet.").waitFor();

    await page.goto(`/projects/${createdProject}/knowledge`, { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: "Template runbook" }).click();
    await page.getByRole("heading", { name: "Checklist", level: 2 }).waitFor();
    assert.equal(await page.locator('[data-markdown-view] input[type="checkbox"]').count(), 2);
    assert.equal(await page.locator('[data-markdown-view] input[type="checkbox"]:checked').count(), 1);
    assert.deepEqual(pageErrors(page), []);
  });

  it("never widens the page at phone width: long URLs, wide tables and long code stay contained", async () => {
    const wideTable = lines(
      `| ${Array.from({ length: 14 }, (_, i) => `Column ${i}`).join(" | ")} |`,
      `| ${Array.from({ length: 14 }, () => "---").join(" | ")} |`,
      `| ${Array.from({ length: 14 }, (_, i) => `value-${i}-${"x".repeat(12)}`).join(" | ")} |`,
    );
    const id = await createDocument(
      "Overflow",
      lines(
        `https://example.com/${"very-long-path-segment-".repeat(12)}`,
        "",
        `Unbroken${"x".repeat(300)}word`,
        "",
        wideTable,
        "",
        "```",
        `const value = "${"y".repeat(400)}";`,
        "```",
      ),
    );
    const page = await newPage();
    await page.setViewportSize({ width: 375, height: 800 });
    for (const path of [`/projects/${projectId}/knowledge/${id}`, `/projects/${projectId}/knowledge/${id}/edit`]) {
      await page.goto(path, { waitUntil: "load" });
      if (path.endsWith("/edit")) await page.getByRole("tab", { name: "Preview" }).click();
      await page.locator("[data-markdown-view] table").waitFor();
      const widths = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth,
        viewport: document.documentElement.clientWidth,
        tableScrolls: (() => {
          const box = document.querySelector("[data-markdown-view] .markdown-table") as HTMLElement;
          return box.scrollWidth > box.clientWidth;
        })(),
        codeScrolls: (() => {
          const pre = document.querySelector("[data-markdown-view] pre") as HTMLElement;
          return pre.scrollWidth > pre.clientWidth;
        })(),
      }));
      assert.ok(widths.page <= widths.viewport, `${path}: page is ${widths.page}px wide in a ${widths.viewport}px viewport`);
      assert.equal(widths.tableScrolls, true, `${path}: the table scrolls inside its own box`);
      assert.equal(widths.codeScrolls, true, `${path}: the code block scrolls inside its own box`);
    }
    // Scrollable regions are reachable by keyboard.
    assert.equal(await page.locator("[data-markdown-view] .markdown-table").getAttribute("tabindex"), "0");
    assert.equal(await page.locator("[data-markdown-view] pre").getAttribute("tabindex"), "0");
  });

  it("searches visible text through the page, not link destinations or syntax", async () => {
    const searchProject = await createProject("Markdown search");
    await createDocument("Portal guide", "Use [the portal](https://portal-secret.example/login) **daily**.", searchProject);
    await createDocument("Other", "nothing to see", searchProject);
    const page = await newPage();
    await page.goto(`/projects/${searchProject}/knowledge`, { waitUntil: "domcontentloaded" });

    const searchBox = page.getByLabel("Search knowledge base");
    await waitForHydration(searchBox);
    await searchBox.fill("the portal daily");
    await page.waitForURL(/search=the\+portal\+daily|search=the%20portal%20daily/);
    await page.getByRole("link", { name: "Portal guide" }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Other" }).count(), 0);
    // The summary is plain text from the rendered document, not Markdown source.
    assert.equal(await page.getByText("Use the portal daily.").count(), 1);

    await searchBox.fill("portal-secret");
    await page.waitForURL(/search=portal-secret/);
    await page.getByText("No documents match").waitFor();
  });
});

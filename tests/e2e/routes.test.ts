/**
 * Every navigation destination renders.
 *
 * The point is coverage of the routes themselves: a page that throws during
 * render, a broken data fetch, or a link pointing at a route that does not
 * exist should all fail here rather than in front of the user.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Page } from "playwright";
import { baseURL, newPage, pageErrors, start, stop, withFreshPage } from "./helpers";

let page: Page;

before(async () => {
  await start();
  page = await newPage();
});

after(async () => stop());

/** Every destination reachable from the sidebar, plus the sub-pages. */
const ROUTES = [
  ["/", "Dashboard"],
  ["/projects", "Projects"],
  ["/projects/new", "New project"],
  ["/favorites", "Favorites"],
  ["/github", "GitHub"],
  ["/uploads", "Uploaded"],
  ["/notes", "Notes"],
  ["/ai", "AI"],
  ["/ai/chat", "Local AI"],
  ["/ai/prompts", "Prompts"],
  ["/ai/prompts/new", "New prompt"],
  ["/ai/workflows", "Automations"],
  ["/notifications", "Notifications"],
  ["/tools", "Tools"],
  ["/integrations", "Integrations"],
  ["/settings", "Settings"],
  ["/my-work", "My Work"],
] as const;

describe("routes", () => {
  for (const [route] of ROUTES) {
    it(`${route} renders`, async () => {
      const response = await page.goto(route, { waitUntil: "domcontentloaded" });
      assert.ok(response, `no response for ${route}`);
      assert.equal(response.status(), 200, `${route} returned ${response.status()}`);

      // A heading proves the page rendered rather than returning a shell.
      await page.waitForSelector("h1", { timeout: 15_000 });
      const heading = (await page.textContent("h1"))?.trim();
      assert.ok(heading && heading.length > 0, `${route} rendered no heading`);
    });
  }

  /*
   * Arriving at a route from another one, rather than loading it directly.
   *
   * This is the shape that caught a hydration failure the direct loads above
   * miss entirely: `<Link>` prefetching is production-only, so the page has to
   * be reached from a page that links to it. The failure was intermittent at
   * roughly forty percent, so each route is visited several times — one clean
   * pass proves nothing.
   */
  it("hydrates cleanly when reached from another page", async () => {
    const failures: string[] = [];

    for (const [route] of ROUTES) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const error = await withFreshPage(async (fresh) => {
          await fresh.goto("/projects", { waitUntil: "networkidle" });
          await fresh.goto(route, { waitUntil: "networkidle" });
          await fresh.waitForTimeout(400);
          return pageErrors(fresh)[0];
        });

        if (error) {
          failures.push(`${route}: ${error}`);
          break;
        }
      }
    }

    assert.deepEqual(failures, [], "pages must hydrate without errors");
  });

  it("/projects/:id/tasks renders (Phase 2, Release A)", async () => {
    const created = await page.request.post(`${baseURL}/api/projects`, {
      data: { name: "Route Smoke Project", source: "manual", type: "software", status: "active" },
    });
    assert.equal(created.status(), 201, await created.text());
    const { project } = (await created.json()) as { project: { id: string } };

    const response = await page.goto(`/projects/${project.id}/tasks`, { waitUntil: "domcontentloaded" });
    assert.ok(response, "no response for /projects/:id/tasks");
    assert.equal(response.status(), 200);

    await page.waitForSelector("h1", { timeout: 15_000 });
    const heading = (await page.textContent("h1"))?.trim();
    assert.ok(heading && heading.length > 0, "/projects/:id/tasks rendered no heading");
  });

  it("/projects/:id/knowledge renders (Phase 2, Release B)", async () => {
    const created = await page.request.post(`${baseURL}/api/projects`, {
      data: { name: "Route Smoke Project Knowledge", source: "manual", type: "software", status: "active" },
    });
    assert.equal(created.status(), 201, await created.text());
    const { project } = (await created.json()) as { project: { id: string } };

    const response = await page.goto(`/projects/${project.id}/knowledge`, { waitUntil: "domcontentloaded" });
    assert.ok(response, "no response for /projects/:id/knowledge");
    assert.equal(response.status(), 200);

    await page.waitForSelector("h1", { timeout: 15_000 });
    const heading = (await page.textContent("h1"))?.trim();
    assert.ok(heading && heading.length > 0, "/projects/:id/knowledge rendered no heading");
  });

  it("returns 404 for a route that does not exist", async () => {
    const response = await page.goto("/definitely-not-a-route", {
      waitUntil: "domcontentloaded",
    });
    assert.equal(response?.status(), 404);
  });

  it("every sidebar link points at a route that renders", async () => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const hrefs = await page.$$eval("nav a[href^='/']", (links) =>
      Array.from(new Set(links.map((a) => a.getAttribute("href")!))),
    );
    assert.ok(hrefs.length > 5, `expected a populated sidebar, saw ${hrefs.length}`);

    for (const href of hrefs) {
      const response = await page.goto(href, { waitUntil: "domcontentloaded" });
      assert.equal(response?.status(), 200, `sidebar link ${href} returned an error`);
    }
  });
});

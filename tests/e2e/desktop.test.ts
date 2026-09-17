/**
 * The desktop shell actually starts.
 *
 * This launches the real Electron main process against the real bundled server,
 * because the things most likely to break in packaging are invisible from the
 * web build: the standalone server not starting, the preload bridge not being
 * exposed, or the renderer quietly gaining Node access.
 *
 * It is skipped unless a standalone build exists, so the ordinary suite does
 * not require a full desktop build first. Produce one with `npm run
 * desktop:build`.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { _electron, type ElectronApplication, type Page } from "playwright";

const standaloneServer = path.resolve(".next/standalone/server.js");
const hasStandalone = existsSync(standaloneServer);

let app: ElectronApplication | null = null;
let window: Page;
let root = "";

before(async () => {
  if (!hasStandalone) return;

  root = mkdtempSync(path.join(tmpdir(), "cc-desktop-"));
  app = await _electron.launch({
    /*
     * The project directory, not desktop/main.js.
     *
     * `serverRoot()` is derived from `app.getAppPath()`, which for a bare
     * script argument is not the repository root — the bundled server is then
     * looked for in the wrong place, and the failure surfaces as a modal error
     * dialog that never closes without a display. Launching the directory lets
     * Electron read `main` from package.json, which is what packaging does.
     */
    args: ["."],
    cwd: process.cwd(),
    env: {
      ...process.env,
      // Its own database and window state, so a run cannot touch real data.
      DATABASE_PATH: path.join(root, "desktop.db"),
      UPLOADS_DIR: path.join(root, "uploads"),
      DASHBOARD_DISABLE_SCHEDULER: "1",
      GITHUB_TOKEN: "",
      // Exercise the bundled-server path rather than attaching to `next dev`.
      DESKTOP_BUNDLED: "1",
      DESKTOP_TEST_MODE: "1",
    },
  });

  window = await app.firstWindow({ timeout: 120_000 });
  await window.waitForLoadState("domcontentloaded");
});

after(async () => {
  await app?.close().catch(() => undefined);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("desktop shell", { skip: hasStandalone ? false : "no standalone build" }, () => {
  it("opens a window serving the dashboard", async () => {
    await window.waitForSelector("h1", { timeout: 60_000 });
    const heading = (await window.textContent("h1"))?.trim();
    assert.ok(heading && heading.length > 0, "the window rendered no heading");

    // Served by the bundled server on localhost, not from a file:// URL.
    assert.match(window.url(), /^http:\/\/127\.0\.0\.1:\d+\//);
  });

  it("keeps Node out of the renderer", async () => {
    const exposure = await window.evaluate(() => ({
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
      module: typeof (window as unknown as { module?: unknown }).module,
    }));

    assert.deepEqual(exposure, {
      require: "undefined",
      process: "undefined",
      module: "undefined",
    });
  });

  it("exposes exactly the bridge surface it means to, and no more", async () => {
    const bridge = await window.evaluate(() => {
      const desktop = (globalThis as unknown as {
        desktop?: Record<string, unknown> & { ai?: Record<string, unknown> };
      }).desktop;
      return desktop
        ? {
            keys: Object.keys(desktop).sort(),
            isDesktop: desktop.isDesktop,
            ai: desktop.ai ? Object.keys(desktop.ai).sort() : null,
          }
        : null;
    });

    assert.ok(bridge, "the preload bridge should be present");
    assert.equal(bridge.isDesktop, true);
    assert.deepEqual(bridge.keys, ["ai", "isDesktop", "onNavigate", "openLocal", "platform"]);

    // Both AI calls take no arguments at all, which is what makes them safe:
    // there is nothing a page could pass that changes what gets executed.
    assert.deepEqual(bridge.ai, ["start", "status"]);
  });

  it("reports local AI status without the page naming anything to run", async () => {
    const status = await window.evaluate(async () => {
      const bridge = (globalThis as unknown as {
        desktop: { ai: { status: (...args: unknown[]) => Promise<Record<string, unknown>> } };
      }).desktop;
      // Arguments are passed deliberately here: the handler must ignore them.
      return bridge.ai.status("/usr/bin/anything", { command: "rm -rf /" });
    });

    assert.equal(typeof status.state, "string");
    assert.equal(typeof status.reachable, "boolean");
  });

  /*
   * `openLocal` takes a project id, never a path. These check that it refuses
   * anything else — the guarantee the whole design rests on is that no argument
   * a page can supply makes it open somewhere unintended.
   */
  it("refuses a malformed request to open a local folder", async () => {
    const results = await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { desktop: {
        openLocal: (id: unknown, action: unknown) => Promise<{ ok: boolean; error?: string }>;
      } }).desktop;

      return {
        traversal: await bridge.openLocal("../../etc", "folder"),
        absolute: await bridge.openLocal("/etc/passwd", "folder"),
        badAction: await bridge.openLocal("prj_abc123", "rm -rf /"),
        notAString: await bridge.openLocal(42, "folder"),
        unknownId: await bridge.openLocal("prj_doesnotexist", "folder"),
      };
    });

    for (const [name, result] of Object.entries(results)) {
      assert.equal(result.ok, false, `${name} should have been refused`);
      assert.ok(result.error, `${name} should explain itself`);
    }

    assert.match(results.badAction.error!, /Unsupported action/);
    assert.match(results.traversal.error!, /Unknown project/);
  });

  it("can navigate within the app", async () => {
    await window.goto(new URL("/projects", window.url()).href, {
      waitUntil: "domcontentloaded",
    });
    await window.waitForSelector("h1", { timeout: 30_000 });
    assert.match((await window.textContent("h1")) ?? "", /project/i);
  });

  it("does not expose the internal desktop secret in renderer DOM or JS environment", async () => {
    const leakCheck = await window.evaluate(() => {
      const html = document.documentElement.outerHTML;
      const win = window as unknown as Record<string, unknown>;
      return {
        hasSecretInHtml: /DESKTOP_INTERNAL_SECRET|x-dashboard-desktop-secret/i.test(html),
        hasSecretInWindow: Object.keys(win).some((k) => /secret/i.test(k)),
        hasSecretInUrl: (globalThis as unknown as { location: Location }).location.href.includes("secret"),
      };
    });

    assert.equal(leakCheck.hasSecretInHtml, false, "HTML must never contain the launch secret");
    assert.equal(leakCheck.hasSecretInWindow, false, "Window object must never contain the launch secret");
    assert.equal(leakCheck.hasSecretInUrl, false, "URL must never contain the launch secret");
  });

  it("proves packaged internal requests to /api/ai/startup succeed via main process internalFetch and fail without secret", async () => {
    // 1. External fetch without launch secret must fail (401)
    const serverUrl = window.url();
    const origin = new URL(serverUrl).origin;
    const directRes = await fetch(`${origin}/api/ai/startup`);
    assert.equal(directRes.status, 401, "Direct request without secret must be rejected with 401");

    // 2. Main process call using internalFetch succeeds (200)
    const internalSuccess = await app!.evaluate(async ({ app: electronApp }) => {
      const fetchFn = (electronApp as unknown as { internalFetchForTesting: (path: string) => Promise<Response> }).internalFetchForTesting;
      const res = await fetchFn("/api/ai/startup");
      const json = (await res.json()) as { enabled?: boolean };
      return { status: res.status, ok: res.ok, enabled: json.enabled !== undefined };
    });

    assert.equal(internalSuccess.status, 200, "internalFetch must attach the secret and return 200");
    assert.equal(internalSuccess.ok, true);
    assert.equal(internalSuccess.enabled, true);
  });
});

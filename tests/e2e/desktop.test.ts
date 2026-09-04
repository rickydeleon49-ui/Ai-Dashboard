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

  it("exposes exactly the one bridge the menu needs", async () => {
    const bridge = await window.evaluate(() => {
      const desktop = (globalThis as unknown as { desktop?: Record<string, unknown> })
        .desktop;
      return desktop
        ? { keys: Object.keys(desktop).sort(), isDesktop: desktop.isDesktop }
        : null;
    });

    assert.ok(bridge, "the preload bridge should be present");
    assert.equal(bridge.isDesktop, true);
    assert.deepEqual(bridge.keys, ["isDesktop", "onNavigate", "platform"]);
  });

  it("can navigate within the app", async () => {
    await window.goto(new URL("/projects", window.url()).href, {
      waitUntil: "domcontentloaded",
    });
    await window.waitForSelector("h1", { timeout: 30_000 });
    assert.match((await window.textContent("h1")) ?? "", /project/i);
  });
});

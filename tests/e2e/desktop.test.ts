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
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import Database from "better-sqlite3";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { assertInertDom, inspectRendered, watch } from "./markdown-dom";

const standaloneServer = path.resolve(".next/standalone/server.js");
const hasStandalone = existsSync(standaloneServer);

let app: ElectronApplication | null = null;
let window: Page;
let root = "";

/**
 * The installed application's profile — what a test run must never touch.
 * Mirrors Electron's `appData` per platform plus the app name.
 */
function realProfileDirectory(): string {
  const appData =
    process.platform === "win32"
      ? process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? path.join(homedir(), "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
  return path.join(appData, "Command Center");
}

const realProfile = realProfileDirectory();
const realDatabase = path.join(realProfile, "data", "dashboard.db");

/** Size and modification time of each real profile file, or absent. Read-only. */
function fingerprint() {
  return [
    realDatabase,
    `${realDatabase}-wal`,
    `${realDatabase}-shm`,
    path.join(realProfile, "settings-key.enc"),
    path.join(realProfile, "window-state.json"),
  ].map((file) => {
    if (!existsSync(file)) return { file, present: false };
    const { size, mtimeMs } = statSync(file);
    return { file, present: true, size, mtimeMs };
  });
}

let realProfileBefore: ReturnType<typeof fingerprint> = [];

/** The paths the main process actually handed the server, read from inside it. */
type DesktopPaths = {
  userData: string;
  database: string;
  uploads: string;
  settingsKey: string;
  windowState: string;
};
let profile: DesktopPaths;

/** True when `file` is `dir` itself or somewhere inside it. */
function isWithin(dir: string, file: string): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

before(async () => {
  if (!hasStandalone) return;

  root = mkdtempSync(path.join(tmpdir(), "cc-desktop-"));
  realProfileBefore = fingerprint();
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
      /*
       * Its own profile — database, uploads, window state and encryption key —
       * so a run cannot touch real data. The main process derives every path
       * from userData, so relocating that is what isolates the run; setting
       * DATABASE_PATH here would be overridden and silently ignored.
       */
      DESKTOP_TEST_USER_DATA: root,
      DASHBOARD_DISABLE_SCHEDULER: "1",
      GITHUB_TOKEN: "",
      // Exercise the bundled-server path rather than attaching to `next dev`.
      DESKTOP_BUNDLED: "1",
      DESKTOP_TEST_MODE: "1",
    },
  });

  window = await app.firstWindow({ timeout: 120_000 });

  /*
   * Checked here, before any test drives the app, so nothing below can run
   * against a profile that is not this run's disposable one. The window exists
   * only after the server has started, so these are the paths it was given.
   */
  profile = await app.evaluate(({ app: electronApp }) => ({
    ...(electronApp as unknown as { desktopPathsForTesting: DesktopPaths }).desktopPathsForTesting,
    live: electronApp.getPath("userData"),
  }));
  const live = (profile as DesktopPaths & { live: string }).live;
  const expected = {
    userData: root,
    database: path.join(root, "data", "dashboard.db"),
    uploads: path.join(root, "data", "uploads"),
    settingsKey: path.join(root, "settings-key.enc"),
    windowState: path.join(root, "window-state.json"),
  };
  try {
    assert.equal(path.resolve(live), path.resolve(root), "Electron userData is not the temporary profile");
    for (const key of Object.keys(expected) as (keyof DesktopPaths)[]) {
      assert.equal(path.resolve(profile[key]), path.resolve(expected[key]), `${key} is not in the temporary profile`);
      assert.ok(!isWithin(realProfile, profile[key]), `${key} points into the real profile`);
    }
  } catch (error) {
    await app.close().catch(() => undefined);
    app = null;
    throw error;
  }

  await window.waitForLoadState("domcontentloaded");
});

after(async () => {
  await app?.close().catch(() => undefined);
  try {
    // Quitting writes window state, so this is the last point the real profile
    // could have been touched.
    if (root) assert.deepEqual(fingerprint(), realProfileBefore, "the real profile changed during the run");
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("desktop shell", { skip: hasStandalone ? false : "no standalone build" }, () => {
  it("runs against a temporary profile, never the real one", async (t) => {
    // A fresh mkdtemp directory per run, so no two runs share a profile.
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^cc-desktop-/);
    t.diagnostic(`userData=${profile.userData}`);
    t.diagnostic(`database=${profile.database}`);
    t.diagnostic(`uploads=${profile.uploads}`);
    t.diagnostic(`settingsKey=${profile.settingsKey}`);
    t.diagnostic(`windowState=${profile.windowState}`);

    // The server created and migrated its database inside the temporary profile.
    const database = profile.database;
    assert.ok(existsSync(database), `expected the test database at ${database}`);
    const db = new Database(database, { readonly: true, fileMustExist: true });
    try {
      const { tables } = db
        .prepare("SELECT count(*) AS tables FROM sqlite_master WHERE type = 'table'")
        .get() as { tables: number };
      assert.ok(tables > 0, "the test database was never migrated — the server used another file");
    } finally {
      db.close();
    }

    // The settings key was generated in the temporary profile too, when the
    // OS keyring is available to protect one.
    const keyringAvailable = await app!.evaluate(({ safeStorage }) =>
      safeStorage.isEncryptionAvailable(),
    );
    if (keyringAvailable) {
      assert.ok(existsSync(profile.settingsKey), `expected the test settings key at ${profile.settingsKey}`);
    }

    // The installed application's profile is exactly as it was before launch.
    assert.notEqual(path.resolve(database), path.resolve(realDatabase));
    assert.deepEqual(fingerprint(), realProfileBefore);
  });

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

  it("serves Release 2D.3 templates offline: create, preview and apply from the renderer with no account", async () => {
    const origin = new URL(window.url()).origin;
    const external: string[] = [];
    const onRequest = (r: { url(): string }) => {
      if (!r.url().startsWith(origin) && !r.url().startsWith("data:") && !r.url().startsWith("devtools:")) external.push(r.url());
    };
    window.on("request", onRequest);
    try {
      await window.goto(new URL("/templates", origin).href, { waitUntil: "domcontentloaded" });
      await window.waitForSelector("h1", { timeout: 30_000 });
      assert.match((await window.textContent("h1")) ?? "", /Templates/);
      // No named inner functions: the test transform would wrap them in a helper the renderer lacks.
      // This application runs in a fresh disposable profile for each test-suite run.
      const result = await window.evaluate(async () => {
        const json = { "content-type": "application/json" };
        const created = await fetch("/api/templates", {
          method: "POST",
          headers: json,
          body: JSON.stringify({
            name: "Desktop template",
            project: { name: "Desktop project" },
            tasks: [{ key: "t1", title: "First task", dueOffset: 1 }],
          }),
        });
        const { template } = (await created.json()) as { template: { id: string } };
        const preview = await fetch(`/api/templates/${template.id}/preview?startDate=2028-02-28`);
        const applied = await fetch(`/api/templates/${template.id}/apply`, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ idempotencyKey: "desktop-shell-template-application", startDate: "2028-02-28" }),
        });
        const project = ((await applied.json()) as { project?: { id: string } }).project;
        const removedProject = project ? (await fetch(`/api/projects/${project.id}`, { method: "DELETE" })).status : null;
        const removedTemplate = (await fetch(`/api/templates/${template.id}`, { method: "DELETE" })).status;
        return {
          created: created.status,
          preview: preview.status,
          due: ((await preview.json()) as { preview: { tasks: { dueDate: string }[] } }).preview.tasks[0]?.dueDate,
          applied: applied.status,
          cleanedUp: removedProject !== null && removedProject < 300 && removedTemplate < 300,
        };
      });
      assert.deepEqual(result, { created: 201, preview: 200, due: "2028-02-29", applied: 201, cleanedUp: true });
      assert.deepEqual(external, [], "templates never reach the network");
    } finally {
      window.off("request", onRequest);
    }
  });

  it("renders Release 2E.1 Markdown offline and hands external links to the controlled boundary only", async () => {
    const origin = new URL(window.url()).origin;
    const watched = watch(window, origin);
    // Record what reaches shell.openExternal instead of opening a real browser.
    await app!.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __opened: string[]; __originalOpenExternal: unknown };
      g.__opened = [];
      g.__originalOpenExternal = shell.openExternal;
      shell.openExternal = (url: string) => {
        g.__opened.push(url);
        return Promise.resolve();
      };
    });
    const windowsBefore = app!.windows().length;
    try {
      const NL = String.fromCharCode(10);
      const source = [
        "# Offline runbook",
        "",
        "- [x] Works without a network",
        "",
        "| A | B |",
        "|---|---|",
        "| 1 | 2 |",
        "",
        "[External docs](https://external.example/docs) [Refused](javascript:window.__xss=1) [Proto](//evil.example)",
        "",
        "![Tracking pixel](https://tracker.example/p.png)",
        "",
        "<img src=x onerror=window.__xss=1><script>window.__xss=1</script>",
      ].join(NL);
      // No named inner functions: the test transform would wrap them in a helper the renderer lacks.
      const ids = await window.evaluate(async (content) => {
        const json = { "content-type": "application/json" };
        const project = await fetch("/api/projects", { method: "POST", headers: json, body: JSON.stringify({ name: "Desktop Markdown" }) });
        const projectId = ((await project.json()) as { project: { id: string } }).project.id;
        const doc = await fetch(`/api/projects/${projectId}/knowledge`, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ title: "Offline doc", content }),
        });
        return { projectId, docId: ((await doc.json()) as { document: { id: string } }).document.id };
      }, source);

      await window.goto(new URL(`/projects/${ids.projectId}/knowledge/${ids.docId}`, origin).href, { waitUntil: "load" });
      await window.waitForSelector("[data-markdown-view] h2", { timeout: 30_000 });
      assert.equal((await window.textContent("[data-markdown-view] h2"))?.trim(), "Offline runbook");
      assertInertDom(await inspectRendered(window), "desktop document");
      assert.equal(await window.locator('[data-markdown-image="blocked"]').textContent(), "[Image: Tracking pixel]");

      const before = window.url();
      await window.getByRole("link", { name: "External docs" }).click();
      const opened = await app!.evaluate(async () => {
        const g = globalThis as unknown as { __opened: string[] };
        for (let i = 0; i < 50 && g.__opened.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
        return g.__opened.slice();
      });
      assert.deepEqual(opened, ["https://external.example/docs"], "the external link went to the system browser boundary");
      assert.equal(window.url(), before, "the app window did not navigate away");
      assert.equal(app!.windows().length, windowsBefore, "no Electron window was opened for it");

      for (const name of ["Refused", "Proto"]) await window.locator('[data-markdown-link="refused"]', { hasText: name }).click();
      const after = await app!.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened.slice());
      assert.deepEqual(after, ["https://external.example/docs"], "refused links never reach openExternal");
      assert.equal(window.url(), before);

      assert.deepEqual(watched.dialogs, []);
      assert.deepEqual(
        watched.foreignRequests.filter((url) => !url.startsWith("devtools:")),
        [],
        "rendering never reaches the network",
      );

      await window.evaluate(async (projectId) => {
        await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
      }, ids.projectId);
    } finally {
      await app!.evaluate(({ shell }) => {
        const g = globalThis as unknown as { __originalOpenExternal: typeof shell.openExternal };
        shell.openExternal = g.__originalOpenExternal;
      });
    }
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

  // Last, so it covers everything the tests above did through the app. A real
  // copy of Command Center open during the run would legitimately change these.
  it("still has not touched the real profile after exercising the app", () => {
    assert.deepEqual(fingerprint(), realProfileBefore);
  });
});

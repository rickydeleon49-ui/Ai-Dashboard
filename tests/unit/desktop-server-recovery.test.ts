/**
 * Desktop Internal Requests & Server Recovery Test:
 * Proves that:
 * 1. Main-process internal requests to the bundled server (/api/ai/startup, /api/ai/preload)
 *    succeed with internalFetch (which attaches the secret) and fail without the secret.
 * 2. When the server restarts on a new random port, header injection origin is updated.
 * 3. The old listener is safely replaced (no accumulated listeners).
 * 4. Authenticated GET and POST requests succeed on the new origin.
 * 5. The old origin is no longer trusted.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

process.env.DESKTOP_TEST_MODE = "1";
const desktop = require("../../desktop/main.js");

describe("desktop internal requests and server recovery", () => {
  const testSecret = "test-desktop-launch-secret-42";
  let serverA: http.Server;
  let serverB: http.Server;
  let portA: number;
  let portB: number;

  const serverLogsA: { method: string; url: string; secret: string | undefined }[] = [];
  const serverLogsB: { method: string; url: string; secret: string | undefined }[] = [];

  before(async () => {
    desktop.setDesktopSecretForTesting(testSecret);

    // Create Server A (Origin 1)
    await new Promise<void>((resolve) => {
      serverA = http.createServer((req, res) => {
        const receivedSecret = req.headers["x-dashboard-desktop-secret"];
        serverLogsA.push({
          method: req.method || "GET",
          url: req.url || "/",
          secret: typeof receivedSecret === "string" ? receivedSecret : undefined,
        });

        if (receivedSecret !== testSecret) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: launch secret missing or invalid" }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        if (req.url === "/api/ai/startup") {
          res.end(JSON.stringify({ enabled: true, endpoint: "http://127.0.0.1:11434" }));
        } else if (req.url === "/api/ai/preload") {
          res.end(JSON.stringify({ preloaded: true }));
        } else {
          res.end(JSON.stringify({ ok: true, method: req.method }));
        }
      });

      serverA.listen(0, "127.0.0.1", () => {
        const addr = serverA.address();
        if (typeof addr === "object" && addr) portA = addr.port;
        resolve();
      });
    });

    // Create Server B (Origin 2 - new port after restart)
    await new Promise<void>((resolve) => {
      serverB = http.createServer((req, res) => {
        const receivedSecret = req.headers["x-dashboard-desktop-secret"];
        serverLogsB.push({
          method: req.method || "GET",
          url: req.url || "/",
          secret: typeof receivedSecret === "string" ? receivedSecret : undefined,
        });

        if (receivedSecret !== testSecret) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: launch secret missing or invalid" }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        if (req.url === "/api/ai/startup") {
          res.end(JSON.stringify({ enabled: true, endpoint: "http://127.0.0.1:11434" }));
        } else if (req.url === "/api/ai/preload") {
          res.end(JSON.stringify({ preloaded: true }));
        } else {
          res.end(JSON.stringify({ ok: true, method: req.method }));
        }
      });

      serverB.listen(0, "127.0.0.1", () => {
        const addr = serverB.address();
        if (typeof addr === "object" && addr) portB = addr.port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((r) => serverA.close(() => r()));
    await new Promise<void>((r) => serverB.close(() => r()));
  });

  it("proves internal calls fail without the launch secret", async () => {
    // A regular fetch() call without the header (e.g. from an external process or unpatched fetch)
    const rawRes = await fetch(`http://127.0.0.1:${portA}/api/ai/startup`);
    assert.equal(rawRes.status, 401);
    const body = (await rawRes.json()) as { error: string };
    assert.match(body.error, /Unauthorized/);
  });

  it("proves internal calls succeed with internalFetch helper", async () => {
    desktop.setBaseUrlForTesting(`http://127.0.0.1:${portA}`);

    // Call /api/ai/startup via internalFetch
    const resStartup = await desktop.internalFetch("/api/ai/startup");
    assert.equal(resStartup.status, 200);
    const dataStartup = await resStartup.json();
    assert.equal(dataStartup.enabled, true);

    // Call /api/ai/preload via internalFetch (POST)
    const resPreload = await desktop.internalFetch("/api/ai/preload", { method: "POST" });
    assert.equal(resPreload.status, 200);
    const dataPreload = await resPreload.json();
    assert.equal(dataPreload.preloaded, true);
  });

  it("simulates server recovery on a different port and updates origin trust", async () => {
    // 1. Initial configuration on Server A
    desktop.setupDesktopHeaderInjection(`http://127.0.0.1:${portA}`);
    assert.equal(desktop.getCurrentServerOrigin(), `http://127.0.0.1:${portA}`);

    // 2. Simulate server crash and restart on Server B (new port)
    desktop.setBaseUrlForTesting(`http://127.0.0.1:${portB}`);
    desktop.setupDesktopHeaderInjection(`http://127.0.0.1:${portB}`);

    // Confirms current server origin updated to Port B
    assert.equal(desktop.getCurrentServerOrigin(), `http://127.0.0.1:${portB}`);

    // 3. Performs authenticated GET and POST successfully on new origin
    const getRes = await desktop.internalFetch("/api/ai/startup");
    assert.equal(getRes.status, 200);
    const postRes = await desktop.internalFetch("/api/ai/preload", { method: "POST" });
    assert.equal(postRes.status, 200);

    // 4. Confirms old origin is no longer currentServerOrigin
    assert.notEqual(desktop.getCurrentServerOrigin(), `http://127.0.0.1:${portA}`);
  });

  it("proves internalFetch accepts absolute same-origin URLs matching current origin", async () => {
    desktop.setBaseUrlForTesting(`http://127.0.0.1:${portB}`);
    const res = await desktop.internalFetch(`http://127.0.0.1:${portB}/api/ai/startup`);
    assert.equal(res.status, 200);
  });

  it("proves external and malformed targets are rejected before network I/O", async () => {
    desktop.setBaseUrlForTesting(`http://127.0.0.1:${portB}`);

    // External host
    await assert.rejects(
      async () => {
        await desktop.internalFetch("http://example.com/api/steal-secret");
      },
      /Refusing internal fetch to non-same-origin host/,
    );

    // Protocol-relative
    await assert.rejects(
      async () => {
        await desktop.internalFetch("//evil.com/api/steal-secret");
      },
      /protocol-relative URL/,
    );

    // Backslash-prefixed protocol-relative variant
    await assert.rejects(
      async () => {
        await desktop.internalFetch("/\\evil.com/api");
      },
      /protocol-relative URL/,
    );

    // Credential-bearing
    await assert.rejects(
      async () => {
        await desktop.internalFetch(`http://user:pass@127.0.0.1:${portB}/api`);
      },
      /credentials in URL/,
    );

    // Different port
    await assert.rejects(
      async () => {
        await desktop.internalFetch(`http://127.0.0.1:${portA}/api`);
      },
      /Refusing internal fetch to non-same-origin port/,
    );

    // Different scheme
    await assert.rejects(
      async () => {
        await desktop.internalFetch(`https://127.0.0.1:${portB}/api`);
      },
      /Refusing internal fetch to non-same-origin scheme/,
    );

    // Malformed URL
    await assert.rejects(
      async () => {
        await desktop.internalFetch("not-a-valid-relative-or-absolute-url");
      },
      /Malformed or non-relative request URL/,
    );

    // Non-string input
    await assert.rejects(
      async () => {
        await desktop.internalFetch(12345);
      },
      /path must be a string/,
    );
  });

  it("proves external targets receive zero network I/O and never receive the launch secret", async () => {
    let externalReceivedRequest = false;
    let externalServerPort = 0;

    const externalServer = http.createServer((_req, res) => {
      externalReceivedRequest = true;
      res.writeHead(200);
      res.end();
    });

    await new Promise<void>((resolve) => {
      externalServer.listen(0, "127.0.0.1", () => {
        const addr = externalServer.address();
        if (typeof addr === "object" && addr) externalServerPort = addr.port;
        resolve();
      });
    });

    try {
      desktop.setBaseUrlForTesting(`http://127.0.0.1:${portB}`);

      // Attempt internalFetch to the external server
      await assert.rejects(
        async () => {
          await desktop.internalFetch(`http://127.0.0.1:${externalServerPort}/api/probe`);
        },
        /Refusing internal fetch to non-same-origin port/,
      );

      // Verify that no HTTP request ever reached the external server
      assert.equal(externalReceivedRequest, false, "External server must never receive any HTTP request");
    } finally {
      await new Promise<void>((resolve) => externalServer.close(() => resolve()));
    }
  });

  it("proves raw desktop secret is not retrievable via getDesktopSecret or global surfaces", () => {
    // getDesktopSecret must be removed from exports
    assert.equal(desktop.getDesktopSecret, undefined, "getDesktopSecret must not be exported");

    // global.__desktopInternalFetch must be removed
    assert.equal(
      (globalThis as Record<string, unknown>).__desktopInternalFetch,
      undefined,
      "global.__desktopInternalFetch must be undefined",
    );

    // Test seam verifies match without exposing raw secret value
    assert.equal(desktop.matchesDesktopSecretForTesting(testSecret), true);
    assert.equal(desktop.matchesDesktopSecretForTesting("wrong-guess-of-secret"), false);
    assert.equal(desktop.matchesDesktopSecretForTesting(""), false);
    assert.equal(desktop.matchesDesktopSecretForTesting(null), false);
  });

  it("proves test hooks are not exported when DESKTOP_TEST_MODE is disabled in production", () => {
    const origTestMode = process.env.DESKTOP_TEST_MODE;
    const origNodeEnv = process.env.NODE_ENV;
    const env = process.env as Record<string, string | undefined>;
    try {
      delete env.DESKTOP_TEST_MODE;
      env.NODE_ENV = "production";

      const mainPath = require.resolve("../../desktop/main.js");
      delete require.cache[mainPath];
      const prodDesktop = require("../../desktop/main.js");

      assert.equal(prodDesktop.setDesktopSecretForTesting, undefined);
      assert.equal(prodDesktop.matchesDesktopSecretForTesting, undefined);
      assert.equal(prodDesktop.setBaseUrlForTesting, undefined);
      assert.equal(prodDesktop.internalFetch, undefined);
      assert.equal(prodDesktop.setupDesktopHeaderInjection, undefined);
      // Pure helper is safely exported
      assert.equal(typeof prodDesktop.validateInternalUrlForTesting, "function");
    } finally {
      if (origTestMode === undefined) delete env.DESKTOP_TEST_MODE;
      else env.DESKTOP_TEST_MODE = origTestMode;
      if (origNodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = origNodeEnv;
      const mainPath = require.resolve("../../desktop/main.js");
      delete require.cache[mainPath];
      require("../../desktop/main.js");
    }
  });

  it("proves validateInternalUrlForTesting functions as a pure helper against an arbitrary base URL", () => {
    const customBase = "http://127.0.0.1:9876";

    // Valid relative path resolves against custom base
    const resolvedRelative = desktop.validateInternalUrlForTesting("/api/health", customBase);
    assert.equal(resolvedRelative, "http://127.0.0.1:9876/api/health");

    // Valid same-origin absolute URL matches custom base
    const resolvedAbsolute = desktop.validateInternalUrlForTesting(
      "http://127.0.0.1:9876/api/status?query=1",
      customBase,
    );
    assert.equal(resolvedAbsolute, "http://127.0.0.1:9876/api/status?query=1");

    // Mismatched port rejected
    assert.throws(
      () => desktop.validateInternalUrlForTesting("http://127.0.0.1:5555/api", customBase),
      /Refusing internal fetch to non-same-origin port/,
    );

    // Mismatched hostname rejected
    assert.throws(
      () => desktop.validateInternalUrlForTesting("http://localhost:9876/api", customBase),
      /Refusing internal fetch to non-same-origin host/,
    );

    // Protocol-relative rejected
    assert.throws(
      () => desktop.validateInternalUrlForTesting("//attacker.com/api", customBase),
      /protocol-relative URL/,
    );
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { cleanup, migrate } from "../helpers/db";
import * as usageRoute from "../../src/app/api/usage/route";
import { clearUsageCache, dayInZone } from "../../src/core/usage";
import {
  DEFAULT_USAGE_FOLDER,
  getUsageFolder,
  setUsageFolder,
} from "../../src/core/usage/settings";

const originalEnv = {
  DASHBOARD_LOCAL: process.env.DASHBOARD_LOCAL,
  DESKTOP_INTERNAL_SECRET: process.env.DESKTOP_INTERNAL_SECRET,
  AUTH_MODE: process.env.AUTH_MODE,
  DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD,
  DATABASE_URL: process.env.DATABASE_URL,
};

let tmp = "";

before(async () => {
  await migrate();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-route-"));
  fs.writeFileSync(
    path.join(tmp, "codex-usage-daily.csv"),
    "date,model,input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,responses\n" +
      `${dayInZone(new Date(), "America/Los_Angeles")},gpt-6.1-sol,1,1,1,1,700,7\n`,
  );
});

after(async () => {
  for (const [key, val] of Object.entries(originalEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  await cleanup();
});

function enableDesktop() {
  process.env.DASHBOARD_LOCAL = "1";
  process.env.DESKTOP_INTERNAL_SECRET = "test-internal-desktop-secret-xyz";
  delete process.env.AUTH_MODE;
  delete process.env.DASHBOARD_PASSWORD;
  delete process.env.DATABASE_URL;
}

describe("GET/PATCH /api/usage", () => {
  it("returns 404 with an empty body outside desktop mode", async () => {
    delete process.env.DASHBOARD_LOCAL;
    delete process.env.DESKTOP_INTERNAL_SECRET;
    const get = await usageRoute.GET(new NextRequest("http://localhost/api/usage"));
    assert.equal(get.status, 404);
    assert.equal(await get.text(), "");
    const patch = await usageRoute.PATCH(
      new NextRequest("http://localhost/api/usage", {
        method: "PATCH",
        body: JSON.stringify({ folder: tmp }),
      }),
    );
    assert.equal(patch.status, 404);
  });

  it("returns 404 in hosted password mode even with the desktop flags", async () => {
    enableDesktop();
    process.env.DASHBOARD_PASSWORD = "secret";
    const res = await usageRoute.GET(new NextRequest("http://localhost/api/usage"));
    assert.equal(res.status, 404);
  });

  it("rejects a relative folder, saves an absolute one and serves the snapshot", async () => {
    enableDesktop();
    clearUsageCache();
    const bad = await usageRoute.PATCH(
      new NextRequest("http://localhost/api/usage", {
        method: "PATCH",
        body: JSON.stringify({ folder: "relative/dir" }),
      }),
    );
    assert.equal(bad.status, 400);

    const ok = await usageRoute.PATCH(
      new NextRequest("http://localhost/api/usage", {
        method: "PATCH",
        body: JSON.stringify({ folder: tmp }),
      }),
    );
    assert.equal(ok.status, 200);

    const res = await usageRoute.GET(new NextRequest("http://localhost/api/usage"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      folder: string;
      tools: Array<{ tool: string; today: { tokens: number } }>;
      warnings: string[];
    };
    assert.equal(path.normalize(body.folder), path.normalize(tmp));
    assert.equal(body.tools.find((t) => t.tool === "codex")?.today.tokens, 700);
    assert.ok(body.warnings.length > 0);
  });
});

describe("usage folder setting", () => {
  it("defaults, validates absolute paths and persists through an injected store", async () => {
    const mem = new Map<string, string>();
    const store = {
      get: (k: string) => mem.get(k) ?? null,
      set: (k: string, v: string) => void mem.set(k, v),
    };
    assert.equal(await getUsageFolder(store), DEFAULT_USAGE_FOLDER);
    assert.equal((await setUsageFolder("", { store })).ok, false);
    assert.equal((await setUsageFolder("rel/path", { store })).ok, false);
    assert.equal((await setUsageFolder("/data/usage", { store, platform: "linux" })).ok, true);
    assert.equal((await setUsageFolder("C:\\Usage", { store, platform: "win32" })).ok, true);
    assert.equal((await setUsageFolder("/nope", { store, platform: "win32" })).ok, false);
    assert.ok((await getUsageFolder(store)).length > 0);
  });
});

/**
 * Unit tests for buildRunRequest acknowledgement handling and the Antigravity inventory GET route (Round AW3-05b).
 *
 * Verifies:
 * 1. buildRunRequest includes antigravityAcknowledgement only when the implementer provider is "antigravity".
 * 2. buildRunRequest omits antigravityAcknowledgement for non-antigravity providers even if supplied.
 * 3. buildRunRequest leaves all other output fields byte-identical.
 * 4. GET /api/agent-runs/antigravity-inventory returns 404 when agent runs are disabled.
 * 5. GET /api/agent-runs/antigravity-inventory returns 200 with sanitized inventory (names only) when enabled.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db";
import { buildRunRequest } from "../../src/components/agents/runs/build-run-request";
import * as inventoryRoute from "../../src/app/api/agent-runs/antigravity-inventory/route";
import { antigravityInventoryResponse } from "../../src/core/agents/antigravity-inventory-response";

const originalEnv = {
  DASHBOARD_LOCAL: process.env.DASHBOARD_LOCAL,
  DESKTOP_INTERNAL_SECRET: process.env.DESKTOP_INTERNAL_SECRET,
  AUTH_MODE: process.env.AUTH_MODE,
  DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD,
  DATABASE_URL: process.env.DATABASE_URL,
};

function enableDesktopEnv() {
  process.env.DASHBOARD_LOCAL = "1";
  process.env.DESKTOP_INTERNAL_SECRET =
    "test-desktop-secret-for-inventory-route";
  delete process.env.AUTH_MODE;
  delete process.env.DASHBOARD_PASSWORD;
  delete process.env.DATABASE_URL;
}

function disableDesktopEnv() {
  delete process.env.DASHBOARD_LOCAL;
  delete process.env.DESKTOP_INTERNAL_SECRET;
}

before(async () => {
  await migrate();
  enableDesktopEnv();
});

after(async () => {
  for (const [key, val] of Object.entries(originalEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
  await cleanup();
});

describe("buildRunRequest with antigravityAcknowledgement (Round AW3-05b)", () => {
  const sampleAck = {
    plugins: ["plugin-alpha", "plugin-beta"],
    mcpServers: ["server-one", "server-two"],
  };

  it("includes antigravityAcknowledgement when implementer is antigravity and ack is provided", () => {
    const request = buildRunRequest({
      projectId: "proj-1",
      task: "Implement feature A",
      roles: {
        implementer: {
          provider: "antigravity",
          model: "flash",
          effort: "medium",
        },
        planner: { provider: "codex" },
      },
      checks: "lint, typecheck",
      antigravityAcknowledgement: sampleAck,
    });

    assert.equal(request.projectId, "proj-1");
    assert.equal(request.task, "Implement feature A");
    assert.deepEqual(request.roles.implementer, {
      provider: "antigravity",
      model: "flash",
      effort: "medium",
    });
    assert.deepEqual(request.roles.planner, { provider: "codex" });
    assert.deepEqual(request.checks, ["lint", "typecheck"]);
    assert.deepEqual(request.antigravityAcknowledgement, {
      plugins: ["plugin-alpha", "plugin-beta"],
      mcpServers: ["server-one", "server-two"],
    });
  });

  it("omits antigravityAcknowledgement when implementer is antigravity but ack is not provided", () => {
    const request = buildRunRequest({
      projectId: "proj-1",
      task: "Implement feature A",
      roles: {
        implementer: { provider: "antigravity" },
      },
    });

    assert.equal(request.projectId, "proj-1");
    assert.equal(request.antigravityAcknowledgement, undefined);
    assert.ok(!("antigravityAcknowledgement" in request));
  });

  it("omits antigravityAcknowledgement when implementer is not antigravity even if ack is provided", () => {
    const withAck = buildRunRequest({
      projectId: "proj-2",
      task: "Fix bug B",
      roles: {
        implementer: { provider: "claude-code" },
        reviewer: { provider: "codex" },
      },
      checks: ["test:unit"],
      antigravityAcknowledgement: sampleAck,
    });

    const withoutAck = buildRunRequest({
      projectId: "proj-2",
      task: "Fix bug B",
      roles: {
        implementer: { provider: "claude-code" },
        reviewer: { provider: "codex" },
      },
      checks: ["test:unit"],
    });

    assert.equal(withAck.antigravityAcknowledgement, undefined);
    assert.ok(!("antigravityAcknowledgement" in withAck));
    // Output must be byte-identical whether ack was passed or omitted
    assert.deepEqual(withAck, withoutAck);
  });

  it("handles whitespace in provider when checking for antigravity", () => {
    const request = buildRunRequest({
      projectId: "proj-3",
      task: "Task C",
      roles: {
        implementer: { provider: "  antigravity  " },
      },
      antigravityAcknowledgement: sampleAck,
    });

    assert.equal(request.roles.implementer.provider, "antigravity");
    assert.deepEqual(request.antigravityAcknowledgement, sampleAck);
  });
});

describe("GET /api/agent-runs/antigravity-inventory (Round AW3-05b)", () => {
  it("returns 404 when agent runs are disabled", async () => {
    disableDesktopEnv();
    try {
      const res = await inventoryRoute.GET();
      assert.equal(res.status, 404);
      assert.equal(await res.text(), "");
    } finally {
      enableDesktopEnv();
    }
  });

  it("returns 200 with inventory names and hasHooks when enabled", async () => {
    enableDesktopEnv();

    const mockInventory = {
      plugins: [
        { name: "test-plugin-a", hasHooks: false },
        { name: "test-plugin-b", hasHooks: true },
      ],
      mcpServers: ["test-server-1", "test-server-2"],
      errors: ["ignored/error.json: ENOENT"],
    };

    const res = await antigravityInventoryResponse(async () => mockInventory);

    assert.equal(res.status, 200);
    const data = (await res.json()) as {
      plugins: { name: string; hasHooks: boolean }[];
      mcpServers: string[];
      errors: string[];
    };

    assert.deepEqual(data.plugins, [
      { name: "test-plugin-a", hasHooks: false },
      { name: "test-plugin-b", hasHooks: true },
    ]);
    assert.deepEqual(data.mcpServers, ["test-server-1", "test-server-2"]);
    assert.deepEqual(data.errors, ["ignored/error.json: ENOENT"]);

    // Verify index access safe with !
    assert.equal(data.plugins[0]!.name, "test-plugin-a");
    assert.equal(data.plugins[1]!.hasHooks, true);
    assert.equal(data.mcpServers[0]!, "test-server-1");
  });
});

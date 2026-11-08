/**
 * Unit tests for Antigravity plugin and MCP server acknowledgement check (AW3-05a).
 *
 * Source of truth: docs/design/AW-agent-workflow-control-center.md §3.2, §16.3 row 5.
 *
 * Verifies:
 * 1. Non-antigravity provider is ignored even if inventory is non-empty and ack is missing.
 * 2. Empty inventory is ok without acknowledgement.
 * 3. Non-empty inventory without acknowledgement returns the missing error.
 * 4. Exact match in a different order returns ok.
 * 5. Extra plugin in inventory or acknowledgement returns the changed error.
 * 6. Extra MCP server in inventory or acknowledgement returns the changed error.
 * 7. runRequestSchema accepts a request with antigravityAcknowledgement and when omitted.
 * 8. runRequestSchema rejects unknown keys inside antigravityAcknowledgement (strict).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AntigravityInventory } from "../../src/core/agents/adapters/antigravity-inventory";
import { checkAntigravityAcknowledgement } from "../../src/core/agents/antigravity-ack";
import { runRequestSchema } from "../../src/core/agents/schema";

describe("checkAntigravityAcknowledgement", () => {
  const emptyInventory: AntigravityInventory = {
    plugins: [],
    mcpServers: [],
    errors: [],
  };

  const sampleInventory: AntigravityInventory = {
    plugins: [
      { name: "plugin-alpha", hasHooks: false },
      { name: "plugin-beta", hasHooks: true },
    ],
    mcpServers: ["server-one", "server-two"],
    errors: [],
  };

  it("ignores non-antigravity providers even when inventory is non-empty and ack is missing", () => {
    const request = {
      roles: { implementer: { provider: "claude-code" } },
    };
    const result = checkAntigravityAcknowledgement(request, sampleInventory);
    assert.deepEqual(result, { ok: true });
  });

  it("allows antigravity provider with empty inventory without acknowledgement", () => {
    const request = {
      roles: { implementer: { provider: "antigravity" } },
    };
    const result = checkAntigravityAcknowledgement(request, emptyInventory);
    assert.deepEqual(result, { ok: true });
  });

  it("returns missing error when inventory has plugins and no ack is provided", () => {
    const request = {
      roles: { implementer: { provider: "antigravity" } },
    };
    const inv: AntigravityInventory = {
      plugins: [{ name: "my-plugin", hasHooks: false }],
      mcpServers: [],
      errors: [],
    };
    const result = checkAntigravityAcknowledgement(request, inv);
    assert.deepEqual(result, {
      ok: false,
      error:
        "Antigravity loads plugins or MCP servers on this computer; acknowledge them before starting the run.",
    });
  });

  it("returns missing error when inventory has mcpServers and no ack is provided", () => {
    const request = {
      roles: { implementer: { provider: "antigravity" } },
    };
    const inv: AntigravityInventory = {
      plugins: [],
      mcpServers: ["server-one"],
      errors: [],
    };
    const result = checkAntigravityAcknowledgement(request, inv);
    assert.deepEqual(result, {
      ok: false,
      error:
        "Antigravity loads plugins or MCP servers on this computer; acknowledge them before starting the run.",
    });
  });

  it("returns ok when acknowledgement exactly matches inventory in a different order", () => {
    const request = {
      roles: { implementer: { provider: "antigravity" } },
      antigravityAcknowledgement: {
        plugins: ["plugin-beta", "plugin-alpha"],
        mcpServers: ["server-two", "server-one"],
      },
    };
    const result = checkAntigravityAcknowledgement(request, sampleInventory);
    assert.deepEqual(result, { ok: true });
  });

  it("returns changed error when an extra plugin is in the inventory", () => {
    const request = {
      roles: { implementer: { provider: "antigravity" } },
      antigravityAcknowledgement: {
        plugins: ["plugin-alpha"],
        mcpServers: ["server-one", "server-two"],
      },
    };
    const result = checkAntigravityAcknowledgement(request, sampleInventory);
    assert.deepEqual(result, {
      ok: false,
      error:
        "The Antigravity plugins or MCP servers changed since you acknowledged them; review and acknowledge again.",
    });
  });

  it("returns changed error when an extra plugin is in the acknowledgement", () => {
    const request = {
      roles: { implementer: { provider: "antigravity" } },
      antigravityAcknowledgement: {
        plugins: ["plugin-alpha", "plugin-beta", "plugin-gamma"],
        mcpServers: ["server-one", "server-two"],
      },
    };
    const result = checkAntigravityAcknowledgement(request, sampleInventory);
    assert.deepEqual(result, {
      ok: false,
      error:
        "The Antigravity plugins or MCP servers changed since you acknowledged them; review and acknowledge again.",
    });
  });

  it("returns changed error when an extra MCP server is in the inventory", () => {
    const request = {
      roles: { implementer: { provider: "antigravity" } },
      antigravityAcknowledgement: {
        plugins: ["plugin-alpha", "plugin-beta"],
        mcpServers: ["server-one"],
      },
    };
    const result = checkAntigravityAcknowledgement(request, sampleInventory);
    assert.deepEqual(result, {
      ok: false,
      error:
        "The Antigravity plugins or MCP servers changed since you acknowledged them; review and acknowledge again.",
    });
  });

  it("returns changed error when an extra MCP server is in the acknowledgement", () => {
    const request = {
      roles: { implementer: { provider: "antigravity" } },
      antigravityAcknowledgement: {
        plugins: ["plugin-alpha", "plugin-beta"],
        mcpServers: ["server-one", "server-two", "server-three"],
      },
    };
    const result = checkAntigravityAcknowledgement(request, sampleInventory);
    assert.deepEqual(result, {
      ok: false,
      error:
        "The Antigravity plugins or MCP servers changed since you acknowledged them; review and acknowledge again.",
    });
  });
});

describe("runRequestSchema with antigravityAcknowledgement", () => {
  it("accepts a request with a valid antigravityAcknowledgement", () => {
    const valid = {
      projectId: "proj_123",
      task: "Build feature",
      roles: { implementer: { provider: "antigravity" } },
      checks: ["lint"],
      antigravityAcknowledgement: {
        plugins: ["plugin-a", "plugin-b"],
        mcpServers: ["server-1"],
      },
    };
    const parsed = runRequestSchema.parse(valid);
    assert.deepEqual(parsed.antigravityAcknowledgement, {
      plugins: ["plugin-a", "plugin-b"],
      mcpServers: ["server-1"],
    });
  });

  it("accepts a request without antigravityAcknowledgement (optional)", () => {
    const valid = {
      projectId: "proj_123",
      task: "Build feature",
      roles: { implementer: { provider: "antigravity" } },
    };
    const parsed = runRequestSchema.parse(valid);
    assert.equal(parsed.antigravityAcknowledgement, undefined);
  });

  it("rejects an unknown key inside antigravityAcknowledgement (strict)", () => {
    const invalid = {
      projectId: "proj_123",
      task: "Build feature",
      roles: { implementer: { provider: "antigravity" } },
      antigravityAcknowledgement: {
        plugins: ["plugin-a"],
        mcpServers: ["server-1"],
        extraKey: "forbidden",
      },
    };
    assert.throws(
      () => runRequestSchema.parse(invalid),
      /unrecognized_keys/i,
    );
  });

  it("rejects empty strings in plugins or mcpServers", () => {
    assert.throws(
      () =>
        runRequestSchema.parse({
          projectId: "proj_123",
          task: "Build feature",
          roles: { implementer: { provider: "antigravity" } },
          antigravityAcknowledgement: {
            plugins: [""],
            mcpServers: ["server-1"],
          },
        }),
      (err: unknown) => err instanceof Error && /too_small/.test(err.message),
    );

    assert.throws(
      () =>
        runRequestSchema.parse({
          projectId: "proj_123",
          task: "Build feature",
          roles: { implementer: { provider: "antigravity" } },
          antigravityAcknowledgement: {
            plugins: ["plugin-a"],
            mcpServers: [""],
          },
        }),
      (err: unknown) => err instanceof Error && /too_small/.test(err.message),
    );
  });
});

/**
 * Unit tests for agent settings API route, navigation filtering, and pure logic (Release AW.1, AW1-12).
 *
 * Covers:
 * 1. Desktop availability gate (returns 404 with empty body when disabled).
 * 2. GET /api/agent-settings (storage, statuses, provider probes).
 * 3. PATCH /api/agent-settings (path validation, roots.ts containment reuse, update persistence).
 * 4. Navigation entry and visibility filtering (isNavItemVisible, getVisibleNavigation).
 * 5. inspectRootStatus pure logic (availability, drive root, filesystem detection, warnings).
 * 6. getProviderProbes pure logic (models, error handling, mock probes).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { cleanup, migrate } from "../helpers/db";
import * as agentSettingsRoute from "../../src/app/api/agent-settings/route";
import {
  inspectRootStatus,
  getAgentStorageSettings,
} from "../../src/core/agents/roots";
import {
  getProviderProbes,
  CLAUDE_CODE_MODELS,
  FAKE_AGENT_MODELS,
} from "../../src/core/agents/provider-probes";
import {
  NAVIGATION,
  getVisibleNavigation,
  isNavItemVisible,
  type NavItem,
} from "../../src/config/navigation";

const originalEnv = {
  DASHBOARD_LOCAL: process.env.DASHBOARD_LOCAL,
  DESKTOP_INTERNAL_SECRET: process.env.DESKTOP_INTERNAL_SECRET,
  AUTH_MODE: process.env.AUTH_MODE,
  DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD,
  DATABASE_URL: process.env.DATABASE_URL,
};

function enableDesktopEnv() {
  process.env.DASHBOARD_LOCAL = "1";
  process.env.DESKTOP_INTERNAL_SECRET = "test-internal-desktop-secret-xyz";
  delete process.env.AUTH_MODE;
  delete process.env.DASHBOARD_PASSWORD;
  delete process.env.DATABASE_URL;
}

function disableDesktopEnv() {
  delete process.env.DASHBOARD_LOCAL;
  delete process.env.DESKTOP_INTERNAL_SECRET;
}

function jsonRequest(
  url: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  const finalHeaders = new Headers(headers);
  if (body !== undefined) {
    finalHeaders.set("Content-Type", "application/json");
  }
  return new NextRequest(url, {
    method,
    headers: finalHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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

describe("Agent Settings (Release AW.1, AW1-12)", () => {
  describe("desktop availability gate (404)", () => {
    it("returns 404 with empty body for GET and PATCH when desktop env is disabled", async () => {
      disableDesktopEnv();

      const getRes = await agentSettingsRoute.GET(
        new NextRequest("http://localhost/api/agent-settings"),
      );
      assert.equal(getRes.status, 404);
      assert.equal(await getRes.text(), "");

      const patchRes = await agentSettingsRoute.PATCH(
        jsonRequest("http://localhost/api/agent-settings", "PATCH", {
          workspaceRoots: ["/some/path"],
        }),
      );
      assert.equal(patchRes.status, 404);
      assert.equal(await patchRes.text(), "");

      enableDesktopEnv();
    });

    it("returns 404 when AUTH_MODE=accounts or DATABASE_URL is set", async () => {
      enableDesktopEnv();
      process.env.AUTH_MODE = "accounts";
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";

      const getRes = await agentSettingsRoute.GET(
        new NextRequest("http://localhost/api/agent-settings"),
      );
      assert.equal(getRes.status, 404);

      enableDesktopEnv();
    });
  });

  describe("GET /api/agent-settings", () => {
    it("returns storage, statuses, and provider probes in desktop local mode", async () => {
      enableDesktopEnv();

      const res = await agentSettingsRoute.GET(
        new NextRequest("http://localhost/api/agent-settings"),
      );
      assert.equal(res.status, 200);

      const data = (await res.json()) as {
        storage: { workspaceRoots: string[]; worktreeRoot: string; runStore: string };
        statuses: {
          workspaceRoots: unknown[];
          worktreeRoot: { available: boolean; drive: string; note?: string; warning?: string };
          runStore: { available: boolean; drive: string; note?: string; warning?: string };
        };
        providers: Array<{ id: string; name: string; installed: boolean; models: string[] }>;
      };

      assert.ok(data.storage, "expected storage object");
      assert.ok(Array.isArray(data.storage.workspaceRoots));
      assert.ok(typeof data.storage.worktreeRoot === "string");
      assert.ok(typeof data.storage.runStore === "string");

      assert.ok(data.statuses, "expected statuses object");
      assert.ok(Array.isArray(data.statuses.workspaceRoots));
      assert.ok(data.statuses.worktreeRoot);
      assert.ok(data.statuses.runStore);
      assert.equal(data.statuses.worktreeRoot.available, true);
      assert.equal(data.statuses.worktreeRoot.note, "Created on the first run.");
      assert.equal(data.statuses.worktreeRoot.warning, undefined);
      assert.equal(data.statuses.runStore.available, true);
      assert.equal(data.statuses.runStore.note, "Created on the first run.");
      assert.equal(data.statuses.runStore.warning, undefined);

      assert.ok(Array.isArray(data.providers), "expected providers array");
      const claude = data.providers.find((p) => p.id === "claude-code");
      assert.ok(claude, "expected claude-code provider");
      assert.equal(claude.name, "Claude Code");
      assert.deepEqual(claude.models, CLAUDE_CODE_MODELS);

      const fake = data.providers.find((p) => p.id === "fake");
      assert.ok(fake, "expected fake provider");
      assert.equal(fake.installed, true);
      assert.deepEqual(fake.models, FAKE_AGENT_MODELS);
    });
  });

  describe("PATCH /api/agent-settings validation & containment (reuses roots.ts)", () => {
    it("rejects non-array workspaceRoots", async () => {
      enableDesktopEnv();

      const res = await agentSettingsRoute.PATCH(
        jsonRequest("http://localhost/api/agent-settings", "PATCH", {
          workspaceRoots: "not-an-array",
        }),
      );
      assert.equal(res.status, 400);
      const data = (await res.json()) as { error: string };
      assert.match(data.error, /array of string paths/);
    });

    it("rejects relative path candidates using roots.ts validation", async () => {
      enableDesktopEnv();

      const res = await agentSettingsRoute.PATCH(
        jsonRequest("http://localhost/api/agent-settings", "PATCH", {
          workspaceRoots: ["relative/path"],
        }),
      );
      assert.equal(res.status, 400);
      const data = (await res.json()) as { error: string };
      assert.match(data.error, /not an absolute local path/);
    });

    it("rejects filesystem root candidates using roots.ts validation", async () => {
      enableDesktopEnv();

      const rootCandidate = process.platform === "win32" ? "C:\\" : "/";
      const res = await agentSettingsRoute.PATCH(
        jsonRequest("http://localhost/api/agent-settings", "PATCH", {
          workspaceRoots: [rootCandidate],
        }),
      );
      assert.equal(res.status, 400);
      const data = (await res.json()) as { error: string };
      assert.match(data.error, /filesystem root is not allowed/);
    });

    it("rejects workspace root inside runStore", async () => {
      enableDesktopEnv();

      const storage = await getAgentStorageSettings();
      const insideRunStore = path.join(storage.runStore, "workspace-inside");

      const res = await agentSettingsRoute.PATCH(
        jsonRequest("http://localhost/api/agent-settings", "PATCH", {
          workspaceRoots: [insideRunStore],
        }),
      );
      assert.equal(res.status, 400);
      const data = (await res.json()) as { error: string };
      assert.match(data.error, /inside/);
    });

    it("accepts valid safe absolute roots and persists them", async () => {
      enableDesktopEnv();

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw1-12-roots-"));
      const validRoot = path.join(tempDir, "Ai Repo clones");
      fs.mkdirSync(validRoot, { recursive: true });

      try {
        const res = await agentSettingsRoute.PATCH(
          jsonRequest("http://localhost/api/agent-settings", "PATCH", {
            workspaceRoots: [validRoot],
          }),
        );
        assert.equal(res.status, 200);
        const data = (await res.json()) as {
          success: boolean;
          storage: { workspaceRoots: string[] };
        };
        assert.equal(data.success, true);
        assert.deepEqual(data.storage.workspaceRoots, [validRoot]);

        // Verify persisted setting matches
        const recheck = await getAgentStorageSettings();
        assert.deepEqual(recheck.workspaceRoots, [validRoot]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("rejects invalid worktreeRoot and accepts valid worktreeRoot", async () => {
      enableDesktopEnv();

      // Relative path fails
      const relRes = await agentSettingsRoute.PATCH(
        jsonRequest("http://localhost/api/agent-settings", "PATCH", {
          worktreeRoot: "rel/worktrees",
        }),
      );
      assert.equal(relRes.status, 400);

      // Valid absolute worktree root succeeds
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw1-12-worktrees-"));
      const validWorktree = path.join(tempDir, "Ai Repo worktrees");
      fs.mkdirSync(validWorktree, { recursive: true });

      try {
        const res = await agentSettingsRoute.PATCH(
          jsonRequest("http://localhost/api/agent-settings", "PATCH", {
            worktreeRoot: validWorktree,
          }),
        );
        assert.equal(res.status, 200);
        const data = (await res.json()) as {
          success: boolean;
          storage: { worktreeRoot: string };
        };
        assert.equal(data.success, true);
        assert.equal(data.storage.worktreeRoot, validWorktree);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("navigation entry and visibility filtering", () => {
    const agentsNavEntry = NAVIGATION.flatMap((g) => g.items).find(
      (i) => i.href === "/agents",
    );

    it("NAVIGATION contains an entry pointing to /agents with label 'Agents'", () => {
      assert.ok(agentsNavEntry, "expected /agents entry in NAVIGATION");
      assert.equal(agentsNavEntry.label, "Agents");
      assert.equal(agentsNavEntry.href, "/agents");
    });

    it("isNavItemVisible hides /agents when agentRunsEnabled is false", () => {
      assert.ok(agentsNavEntry);
      const visible = isNavItemVisible(agentsNavEntry, { agentRunsEnabled: false });
      assert.equal(visible, false);
    });

    it("isNavItemVisible shows /agents when agentRunsEnabled is true and not in accounts mode", () => {
      assert.ok(agentsNavEntry);
      const visible = isNavItemVisible(agentsNavEntry, {
        agentRunsEnabled: true,
        accountsMode: false,
      });
      assert.equal(visible, true);
    });

    it("isNavItemVisible hides /agents in accounts mode even if agentRunsEnabled is true", () => {
      assert.ok(agentsNavEntry);
      const visible = isNavItemVisible(agentsNavEntry, {
        agentRunsEnabled: true,
        accountsMode: true,
      });
      assert.equal(visible, false);
    });

    it("getVisibleNavigation excludes /agents when agentRunsEnabled is false", () => {
      const nav = getVisibleNavigation({ agentRunsEnabled: false });
      const allHrefs = nav.flatMap((g) => g.items.map((i) => i.href));
      assert.equal(allHrefs.includes("/agents"), false);
    });

    it("getVisibleNavigation includes /agents when agentRunsEnabled is true", () => {
      const nav = getVisibleNavigation({
        agentRunsEnabled: true,
        accountsMode: false,
      });
      const allHrefs = nav.flatMap((g) => g.items.map((i) => i.href));
      assert.equal(allHrefs.includes("/agents"), true);
    });
  });

  describe("inspectRootStatus (pure logic)", () => {
    it("reports available: true and drive root for an existing directory", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw1-12-status-"));
      try {
        const status = inspectRootStatus(tempDir);
        assert.equal(status.available, true);
        assert.equal(status.path, tempDir);
        assert.ok(status.drive.length > 0);
        // no probe supplied: the filesystem type is not guessed
        assert.equal(status.fileSystem, undefined);
        assert.equal(status.warning, undefined);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("reports a probed filesystem type and warns when it is not the recommended one", () => {
      const ok = () => ({ ok: true as const });
      const fat = inspectRootStatus("D:\\work", { platform: "win32", checkAvailable: ok, getFsType: () => "exFAT" });
      assert.equal(fat.fileSystem, "exFAT");
      assert.match(fat.warning ?? "", /NTFS is recommended/);
      const ntfs = inspectRootStatus("D:\\work", { platform: "win32", checkAvailable: ok, getFsType: () => "NTFS" });
      assert.equal(ntfs.warning, undefined);
    });

    it("reports available: false and warning for a missing directory/drive", () => {
      const missingPath = path.join(os.tmpdir(), "nonexistent-missing-drive-path-xyz");
      const status = inspectRootStatus(missingPath);
      assert.equal(status.available, false);
      assert.ok(status.warning);
      assert.match(status.warning, /unavailable/i);
    });

    it("warns if Windows filesystem is not NTFS", () => {
      const status = inspectRootStatus("C:\\Projects", {
        platform: "win32",
        checkAvailable: () => ({ ok: true }),
        getFsType: () => "FAT32",
      });
      assert.equal(status.available, true);
      assert.equal(status.fileSystem, "FAT32");
      assert.ok(status.warning);
      assert.match(status.warning, /NTFS is recommended/);
    });

    it("does not warn if Windows filesystem is NTFS", () => {
      const status = inspectRootStatus("H:\\Ai Repo clones", {
        platform: "win32",
        checkAvailable: () => ({ ok: true }),
        getFsType: () => "NTFS",
      });
      assert.equal(status.available, true);
      assert.equal(status.fileSystem, "NTFS");
      assert.equal(status.warning, undefined);
    });

    it("reports available: true and note when missing folder has existing drive and createdOnDemand is true", () => {
      const status = inspectRootStatus("C:\\MissingWorktrees", {
        platform: "win32",
        createdOnDemand: true,
        checkAvailable: () => ({ ok: false, reason: "root unavailable" }),
        driveExists: () => true,
      });
      assert.equal(status.available, true);
      assert.equal(status.note, "Created on the first run.");
      assert.equal(status.warning, undefined);
    });
  });

  describe("getProviderProbes (pure logic)", () => {
    it("formats mock probe outputs with models and auth status", async () => {
      const mockClaude = async () => ({
        installed: true,
        version: "2.1.312",
        authenticated: true as const,
        executable: "/bin/claude",
      });

      const mockFake = async () => ({
        installed: true,
        version: "1.0.0",
        authenticated: true as const,
        executable: "/bin/node",
      });

      const probes = await getProviderProbes({
        claudeProbe: mockClaude,
        codexProbe: async () => ({ installed: false, authenticated: "unknown" as const }),
        fakeProbe: mockFake,
      });

      assert.equal(probes.length, 3);
      const [claude, codex, fake] = probes;
      assert.equal(codex?.id, "codex");

      assert.equal(claude?.installed, true);
      assert.equal(claude?.version, "2.1.312");
      assert.equal(claude?.authenticated, true);
      assert.deepEqual(claude?.models, CLAUDE_CODE_MODELS);

      assert.equal(fake?.installed, true);
      assert.equal(fake?.version, "1.0.0");
      assert.deepEqual(fake?.models, FAKE_AGENT_MODELS);
    });

    it("handles probe errors gracefully without throwing", async () => {
      const failingClaude = async () => {
        throw new Error("CLI crashed unexpectedly");
      };

      const probes = await getProviderProbes({
        claudeProbe: failingClaude,
      });

      const claude = probes.find((p) => p.id === "claude-code");
      assert.ok(claude);
      assert.equal(claude.installed, false);
      assert.equal(claude.authenticated, "unknown");
      assert.equal(claude.error, "CLI crashed unexpectedly");
    });
  });
});

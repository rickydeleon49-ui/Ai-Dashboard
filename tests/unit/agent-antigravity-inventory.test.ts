/**
 * Unit tests for Antigravity inventory discovery (Round AW3-02).
 *
 * Source of truth: docs/design/AW-agent-workflow-control-center.md §3.2, §16.3 row 2.
 *
 * Verifies:
 * 1. Missing .gemini folder returns empty lists and empty errors.
 * 2. Three plugins (hooks sub-folder, hooks.json file, plugin.json without hooks)
 *    return hasHooks true, true, false, sorted by name, and plain files in plugins dir are ignored.
 * 3. plugin.json with non-empty hooks -> true; with empty hooks ({}) -> false.
 * 4. Invalid JSON in a manifest leaves hasHooks false and records an error without file contents.
 * 5. MCP server directory with sub-folders and *.json files de-duplicates and sorts without opening files.
 * 6. Manifest file exceeding 64 KB is skipped and adds EFBIG error.
 * 7. manifest.json with hooks is recognized when plugin.json is absent.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { readAntigravityInventory } from "../../src/core/agents/adapters/antigravity-inventory";

describe("readAntigravityInventory (Round AW3-02)", () => {
  const tempHomes: string[] = [];

  async function createFakeHome(): Promise<string> {
    const fakeHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "agy-inventory-test-"),
    );
    tempHomes.push(fakeHome);
    return fakeHome;
  }

  after(async () => {
    for (const home of tempHomes) {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("returns empty plugins, empty mcpServers, and empty errors when no .gemini folder exists", async () => {
    const fakeHome = await createFakeHome();
    const inv = await readAntigravityInventory({ home: fakeHome });

    assert.deepEqual(inv.plugins, []);
    assert.deepEqual(inv.mcpServers, []);
    assert.deepEqual(inv.errors, []);
  });

  it("lists three plugins with correct hasHooks (hooks folder, hooks.json, plugin.json without hooks), sorted by name, ignoring plain files", async () => {
    const fakeHome = await createFakeHome();
    const pluginsDir = path.join(fakeHome, ".gemini", "config", "plugins");
    await fs.mkdir(pluginsDir, { recursive: true });

    // 1. Plugin with hooks sub-folder (named "plugin-c-hooks-dir" to test sorting)
    const pluginHooksDir = path.join(pluginsDir, "plugin-c-hooks-dir");
    await fs.mkdir(path.join(pluginHooksDir, "hooks"), { recursive: true });

    // 2. Plugin with hooks.json (named "plugin-a-hooks-json")
    const pluginHooksJson = path.join(pluginsDir, "plugin-a-hooks-json");
    await fs.mkdir(pluginHooksJson, { recursive: true });
    await fs.writeFile(
      path.join(pluginHooksJson, "hooks.json"),
      JSON.stringify({}),
      "utf8",
    );

    // 3. Plugin with plugin.json having {"name":"x"} without hooks (named "plugin-b-no-hooks")
    const pluginNoHooks = path.join(pluginsDir, "plugin-b-no-hooks");
    await fs.mkdir(pluginNoHooks, { recursive: true });
    await fs.writeFile(
      path.join(pluginNoHooks, "plugin.json"),
      JSON.stringify({ name: "x" }),
      "utf8",
    );

    // A plain file directly in the plugins directory (must be ignored)
    await fs.writeFile(
      path.join(pluginsDir, "ignore-me.txt"),
      "not a directory",
      "utf8",
    );

    const inv = await readAntigravityInventory({ home: fakeHome });

    assert.deepEqual(inv.plugins, [
      { name: "plugin-a-hooks-json", hasHooks: true },
      { name: "plugin-b-no-hooks", hasHooks: false },
      { name: "plugin-c-hooks-dir", hasHooks: true },
    ]);
    assert.deepEqual(inv.mcpServers, []);
    assert.deepEqual(inv.errors, []);
  });

  it("flags plugin.json with non-empty hooks as true, and with empty hooks ({}) as false", async () => {
    const fakeHome = await createFakeHome();
    const pluginsDir = path.join(fakeHome, ".gemini", "config", "plugins");
    await fs.mkdir(pluginsDir, { recursive: true });

    // Plugin 1: empty hooks object
    const emptyHooksDir = path.join(pluginsDir, "plugin-empty-hooks");
    await fs.mkdir(emptyHooksDir, { recursive: true });
    await fs.writeFile(
      path.join(emptyHooksDir, "plugin.json"),
      JSON.stringify({ hooks: {} }),
      "utf8",
    );

    // Plugin 2: non-empty hooks object
    const withHooksDir = path.join(pluginsDir, "plugin-with-hooks");
    await fs.mkdir(withHooksDir, { recursive: true });
    await fs.writeFile(
      path.join(withHooksDir, "plugin.json"),
      JSON.stringify({ hooks: { onStart: "x" } }),
      "utf8",
    );

    const inv = await readAntigravityInventory({ home: fakeHome });

    assert.deepEqual(inv.plugins, [
      { name: "plugin-empty-hooks", hasHooks: false },
      { name: "plugin-with-hooks", hasHooks: true },
    ]);
    assert.deepEqual(inv.errors, []);
  });

  it("handles invalid JSON in a manifest: plugin is listed with hasHooks false, and errors contains one entry that does not leak file text", async () => {
    const fakeHome = await createFakeHome();
    const pluginsDir = path.join(fakeHome, ".gemini", "config", "plugins");
    await fs.mkdir(pluginsDir, { recursive: true });

    const badPluginDir = path.join(pluginsDir, "bad-plugin");
    await fs.mkdir(badPluginDir, { recursive: true });

    const sensitiveFileText = "SUPER_SECRET_PAYLOAD_NOT_TO_LEAK_IN_ERRORS: 12345";
    await fs.writeFile(
      path.join(badPluginDir, "plugin.json"),
      `{ "invalid_json_body": ${sensitiveFileText} `,
      "utf8",
    );

    const inv = await readAntigravityInventory({ home: fakeHome });

    assert.deepEqual(inv.plugins, [{ name: "bad-plugin", hasHooks: false }]);
    assert.equal(inv.errors.length, 1);
    const errorEntry = inv.errors[0] ?? "";
    assert.ok(
      !errorEntry.includes(sensitiveFileText),
      "Error entry must not contain any file contents",
    );
    assert.ok(
      !errorEntry.includes("SUPER_SECRET"),
      "Error entry must not contain sensitive strings from file",
    );
    assert.match(errorEntry, /plugin\.json/);
    assert.match(errorEntry, /SyntaxError/i);
  });

  it("discovers MCP servers from *.json files and sub-folders, de-duplicating and sorting without reading JSON files", async () => {
    const fakeHome = await createFakeHome();
    const mcpDir = path.join(fakeHome, ".gemini", "antigravity-cli", "mcp");
    await fs.mkdir(mcpDir, { recursive: true });

    // Create a.json (file)
    await fs.writeFile(
      path.join(mcpDir, "a.json"),
      JSON.stringify({ apiKey: "do-not-read-this-secret" }),
      "utf8",
    );

    // Create folder b
    await fs.mkdir(path.join(mcpDir, "b"), { recursive: true });

    // Create folder a (duplicate of a.json base name)
    await fs.mkdir(path.join(mcpDir, "a"), { recursive: true });

    // Non-json file should be ignored
    await fs.writeFile(
      path.join(mcpDir, "notes.txt"),
      "some notes",
      "utf8",
    );

    const inv = await readAntigravityInventory({ home: fakeHome });

    assert.deepEqual(inv.mcpServers, ["a", "b"]);
    assert.deepEqual(inv.errors, []);
  });

  it("recognizes hooks from manifest.json when plugin.json is absent", async () => {
    const fakeHome = await createFakeHome();
    const pluginsDir = path.join(fakeHome, ".gemini", "config", "plugins");
    await fs.mkdir(pluginsDir, { recursive: true });

    const pluginDir = path.join(pluginsDir, "manifest-based-plugin");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "manifest.json"),
      JSON.stringify({ hooks: { onPrompt: "handler" } }),
      "utf8",
    );

    const inv = await readAntigravityInventory({ home: fakeHome });

    assert.deepEqual(inv.plugins, [
      { name: "manifest-based-plugin", hasHooks: true },
    ]);
    assert.deepEqual(inv.errors, []);
  });

  it("skips manifest files larger than 64 KB and records an error", async () => {
    const fakeHome = await createFakeHome();
    const pluginsDir = path.join(fakeHome, ".gemini", "config", "plugins");
    await fs.mkdir(pluginsDir, { recursive: true });

    const largePluginDir = path.join(pluginsDir, "large-plugin");
    await fs.mkdir(largePluginDir, { recursive: true });

    // Create a file > 64 KB
    const largeContent = "x".repeat(65 * 1024);
    await fs.writeFile(
      path.join(largePluginDir, "plugin.json"),
      largeContent,
      "utf8",
    );

    const inv = await readAntigravityInventory({ home: fakeHome });

    assert.deepEqual(inv.plugins, [{ name: "large-plugin", hasHooks: false }]);
    assert.equal(inv.errors.length, 1);
    assert.match(inv.errors[0] ?? "", /plugin\.json/);
    assert.match(inv.errors[0] ?? "", /EFBIG/);
    assert.ok(!(inv.errors[0] ?? "").includes("xxxx"));
  });
});

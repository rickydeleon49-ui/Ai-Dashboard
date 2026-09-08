/**
 * Local AI preferences, model selection and the derived Ollama options.
 *
 * These run against a real throwaway database rather than a stub of the
 * settings store: the store keeps strings, and the interesting failures are all
 * in turning those back into booleans, numbers and enums.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db";

let getAiSettings: typeof import("../../src/core/ai/settings").getAiSettings;
let updateAiSettings: typeof import("../../src/core/ai/settings").updateAiSettings;
let rememberLastProject: typeof import("../../src/core/ai/settings").rememberLastProject;
let settingsStore: typeof import("../../src/core/settings/service");
let config: typeof import("../../src/core/ai/config");
let service: typeof import("../../src/core/ai/service");

before(async () => {
  await migrate();
  ({ getAiSettings, updateAiSettings, rememberLastProject } = await import(
    "../../src/core/ai/settings"
  ));
  settingsStore = await import("../../src/core/settings/service");
  config = await import("../../src/core/ai/config");
  service = await import("../../src/core/ai/service");
});

after(() => cleanup());

beforeEach(() => {
  for (const key of Object.values(settingsStore.SETTING_KEYS)) {
    if (key.startsWith("ai.")) settingsStore.deleteSetting(key);
  }
});

describe("preferences", () => {
  it("starts from defaults that load nothing into VRAM", () => {
    const settings = getAiSettings();
    assert.equal(settings.preloadModel, false);
    assert.equal(settings.defaultModel, "");
    assert.equal(settings.enabled, true);
    assert.equal(settings.autoStart, true);
  });

  it("round-trips every kind of value", () => {
    updateAiSettings({
      enabled: false,
      contextSize: 40960,
      defaultModel: "qwen3-64k:latest",
      reasoningEffort: "high",
      mode: "agent",
    });

    const settings = getAiSettings();
    assert.equal(settings.enabled, false);
    assert.equal(settings.contextSize, 40960);
    assert.equal(settings.defaultModel, "qwen3-64k:latest");
    assert.equal(settings.reasoningEffort, "high");
    assert.equal(settings.mode, "agent");
  });

  it("survives a restart, because it is stored and not held in memory", () => {
    updateAiSettings({ idleTimeoutMinutes: 45 });
    assert.equal(getAiSettings().idleTimeoutMinutes, 45);
    assert.equal(settingsStore.getSetting(settingsStore.SETTING_KEYS.aiIdleTimeoutMinutes), "45");
  });

  it("clearing the default model means 'first installed', not an empty selector", () => {
    updateAiSettings({ defaultModel: "qwen3:8b" });
    updateAiSettings({ defaultModel: "" });
    assert.equal(getAiSettings().defaultModel, "");
  });

  it("falls back for a value that was corrupted outside the app", () => {
    settingsStore.setSetting(settingsStore.SETTING_KEYS.aiContextSize, "banana");
    settingsStore.setSetting(settingsStore.SETTING_KEYS.aiMode, "telepathy");
    const settings = getAiSettings();
    assert.equal(settings.contextSize, config.AI_DEFAULTS.contextSize);
    assert.equal(settings.mode, config.AI_DEFAULTS.mode);
  });

  it("rejects an endpoint that is not a URL", () => {
    assert.equal(config.aiSettingsUpdateSchema.safeParse({ endpoint: "not a url" }).success, false);
    assert.equal(
      config.aiSettingsUpdateSchema.safeParse({ endpoint: "http://127.0.0.1:11434" }).success,
      true,
    );
  });

  it("remembers and forgets the last project", () => {
    rememberLastProject("proj_123");
    assert.equal(getAiSettings().lastProjectId, "proj_123");
    rememberLastProject(null);
    assert.equal(getAiSettings().lastProjectId, "");
  });
});

describe("derived Ollama options", () => {
  it("turns an idle timeout into keep_alive", () => {
    assert.equal(config.keepAliveFor({ idleTimeoutMinutes: 10 }), "10m");
  });

  it("keeps a model resident when the timeout is zero", () => {
    assert.equal(config.keepAliveFor({ idleTimeoutMinutes: 0 }), "-1");
  });

  it("sends no reasoning effort unless one was chosen", () => {
    assert.equal(config.reasoningFor({ reasoningEffort: "default" }), null);
    assert.equal(config.reasoningFor({ reasoningEffort: "low" }), "low");
  });
});

describe("model selection", () => {
  const models = [
    { name: "gpt-oss:20b", size: 0, parameterSize: null, quantization: null, family: null, modifiedAt: null },
    { name: "qwen3:8b", size: 0, parameterSize: null, quantization: null, family: null, modifiedAt: null },
  ];

  it("uses the saved default when it is still installed", () => {
    const settings = { ...config.AI_DEFAULTS, defaultModel: "qwen3:8b" };
    assert.equal(service.resolveModel(settings, models), "qwen3:8b");
  });

  it("falls back to the first installed model when the default was removed", () => {
    const settings = { ...config.AI_DEFAULTS, defaultModel: "qwen3-64k:latest" };
    assert.equal(service.resolveModel(settings, models), "gpt-oss:20b");
  });

  it("selects nothing when no models are installed", () => {
    assert.equal(service.resolveModel(config.AI_DEFAULTS, []), null);
  });
});

describe("runtime detection", () => {
  it("treats the desktop shell as local", () => {
    const previous = process.env.DASHBOARD_LOCAL;
    process.env.DASHBOARD_LOCAL = "1";
    assert.equal(service.detectRuntime(), "desktop");
    assert.equal(service.isLocalRuntime(), true);
    if (previous === undefined) delete process.env.DASHBOARD_LOCAL;
    else process.env.DASHBOARD_LOCAL = previous;
  });
});

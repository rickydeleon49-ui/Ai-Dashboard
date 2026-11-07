/**
 * Unit tests for agent run form model picker options (AW1-17).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildModelOptions,
  resolveProviderModels,
  PROVIDER_DEFAULT_OPTION,
  PROVIDER_DEFAULT_MODEL_VALUE,
  PROVIDER_DEFAULT_MODEL_LABEL,
} from "../../src/components/agents/runs/model-options";
import {
  CLAUDE_CODE_MODELS,
  FAKE_AGENT_MODELS,
} from "../../src/core/agents/provider-probes";

describe("buildModelOptions", () => {
  it("returns an empty array when models is undefined", () => {
    assert.deepEqual(buildModelOptions(undefined), []);
    assert.deepEqual(buildModelOptions(), []);
  });

  it("returns an empty array when models is null", () => {
    assert.deepEqual(buildModelOptions(null), []);
  });

  it("returns an empty array when models is empty", () => {
    assert.deepEqual(buildModelOptions([]), []);
  });

  it("returns an empty array when models contains only blank or whitespace strings", () => {
    assert.deepEqual(buildModelOptions(["", "   "]), []);
  });

  it("prepends Provider default option with value '' when models are present", () => {
    const options = buildModelOptions(["test-model"]);
    assert.equal(options.length, 2);
    assert.deepEqual(options[0], { value: "", label: "Provider default" });
    assert.deepEqual(options[1], { value: "test-model", label: "test-model" });
  });

  it("maps all models into options preserving order", () => {
    const list = ["model-alpha", "model-beta", "model-gamma"];
    const options = buildModelOptions(list);
    assert.equal(options.length, 4);
    assert.equal(options[0]?.value, "");
    assert.equal(options[0]?.label, "Provider default");
    assert.equal(options[1]?.value, "model-alpha");
    assert.equal(options[2]?.value, "model-beta");
    assert.equal(options[3]?.value, "model-gamma");
  });

  it("works with exported CLAUDE_CODE_MODELS", () => {
    const options = buildModelOptions(CLAUDE_CODE_MODELS);
    assert.equal(options.length, CLAUDE_CODE_MODELS.length + 1);
    assert.deepEqual(options[0], PROVIDER_DEFAULT_OPTION);
    for (let i = 0; i < CLAUDE_CODE_MODELS.length; i++) {
      const model = CLAUDE_CODE_MODELS[i];
      assert.deepEqual(options[i + 1], { value: model, label: model });
    }
  });

  it("works with exported FAKE_AGENT_MODELS", () => {
    const options = buildModelOptions(FAKE_AGENT_MODELS);
    assert.equal(options.length, FAKE_AGENT_MODELS.length + 1);
    assert.deepEqual(options[0], PROVIDER_DEFAULT_OPTION);
    for (let i = 0; i < FAKE_AGENT_MODELS.length; i++) {
      const model = FAKE_AGENT_MODELS[i];
      assert.deepEqual(options[i + 1], { value: model, label: model });
    }
  });

  it("deduplicates identical models while preserving first occurrence", () => {
    const options = buildModelOptions(["model-a", "model-b", "model-a"]);
    assert.equal(options.length, 3);
    assert.equal(options[0]?.value, "");
    assert.equal(options[1]?.value, "model-a");
    assert.equal(options[2]?.value, "model-b");
  });

  it("trims whitespace from model strings and ignores empty entries", () => {
    const options = buildModelOptions(["  model-a  ", "", "model-b"]);
    assert.equal(options.length, 3);
    assert.equal(options[0]?.value, "");
    assert.equal(options[1]?.value, "model-a");
    assert.equal(options[2]?.value, "model-b");
  });
});

describe("resolveProviderModels", () => {
  const providers = [
    { id: "claude-code", models: ["claude-3-7-sonnet-20250219"] },
    { id: "fake", models: ["default", "success"] },
    { id: "custom" },
  ];

  it("returns models for the matching provider", () => {
    assert.deepEqual(resolveProviderModels("claude-code", providers), [
      "claude-3-7-sonnet-20250219",
    ]);
    assert.deepEqual(resolveProviderModels("fake", providers), [
      "default",
      "success",
    ]);
  });

  it("returns undefined when matching provider has no models", () => {
    assert.equal(resolveProviderModels("custom", providers), undefined);
  });

  it("returns fallbackModels when matching provider has no models", () => {
    assert.deepEqual(
      resolveProviderModels("custom", providers, ["fallback-1"]),
      ["fallback-1"],
    );
  });

  it("returns fallbackModels when provider is not found", () => {
    assert.deepEqual(
      resolveProviderModels("non-existent", providers, ["fallback-1"]),
      ["fallback-1"],
    );
  });

  it("returns undefined when provider not found and no fallback provided", () => {
    assert.equal(resolveProviderModels("non-existent", providers), undefined);
  });
});

describe("constants", () => {
  it("defines default model constants correctly", () => {
    assert.equal(PROVIDER_DEFAULT_MODEL_VALUE, "");
    assert.equal(PROVIDER_DEFAULT_MODEL_LABEL, "Provider default");
    assert.deepEqual(PROVIDER_DEFAULT_OPTION, {
      value: "",
      label: "Provider default",
    });
  });
});

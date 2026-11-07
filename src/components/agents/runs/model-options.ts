/**
 * Pure helpers for the agent run form model picker (AW1-17).
 *
 * Builds the option list for selectable models, prepending the "Provider default"
 * option (empty string value) when models are configured for the provider.
 * Returns an empty array when the provider has no configured model list,
 * signalling that the free-text Input should be rendered instead.
 */

export interface ModelOption {
  value: string;
  label: string;
}

export const PROVIDER_DEFAULT_MODEL_VALUE = "";
export const PROVIDER_DEFAULT_MODEL_LABEL = "Provider default";

export const PROVIDER_DEFAULT_OPTION: ModelOption = {
  value: PROVIDER_DEFAULT_MODEL_VALUE,
  label: PROVIDER_DEFAULT_MODEL_LABEL,
};

/**
 * Builds the option list for a provider's model picker.
 *
 * If `models` is undefined, null, or empty, returns an empty array to signal
 * that no picker should be shown (free-text fallback).
 *
 * If `models` contains one or more model IDs, returns an array starting with
 * `{ value: "", label: "Provider default" }` followed by each model.
 */
export function buildModelOptions(
  models?: readonly string[] | null,
): ModelOption[] {
  if (!models || models.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const options: ModelOption[] = [PROVIDER_DEFAULT_OPTION];

  for (const m of models) {
    if (typeof m === "string") {
      const trimmed = m.trim();
      if (trimmed.length > 0 && !seen.has(trimmed)) {
        seen.add(trimmed);
        options.push({ value: trimmed, label: trimmed });
      }
    }
  }

  // If there were no valid non-empty models, treat as no model list
  if (options.length === 1) {
    return [];
  }

  return options;
}

/**
 * Resolves the models for the specified provider id from the providers list,
 * falling back to an optional fallback array.
 */
export function resolveProviderModels(
  providerId: string,
  providers?: readonly { id: string; models?: string[] }[],
  fallbackModels?: readonly string[],
): string[] | undefined {
  const match = providers?.find((p) => p.id === providerId);
  if (match && match.models !== undefined) {
    return match.models;
  }
  return fallbackModels ? [...fallbackModels] : undefined;
}

import type { ProjectPolicy } from "@/core/agents/policy";

/**
 * Converts an argv array into a single command text string.
 * Quotes an item with double quotes when it contains a space.
 */
export function argvToText(argv: string[]): string {
  return argv
    .map((item) => (item.includes(" ") ? `"${item}"` : item))
    .join(" ");
}

/**
 * Splits text into argv array by whitespace, honouring double quotes
 * and dropping empty items.
 */
export function textToArgv(text: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (/\s/.test(char) && !inQuotes) {
      if (current.length > 0) {
        result.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current.length > 0) {
    result.push(current);
  }

  return result;
}

/**
 * Determines whether policy `a` is dirty (differs from) policy `b`.
 */
export function isPolicyDirty(a: ProjectPolicy, b: ProjectPolicy): boolean {
  const aChecks = a.checks ?? [];
  const bChecks = b.checks ?? [];
  if (aChecks.length !== bChecks.length) return true;

  for (let i = 0; i < aChecks.length; i++) {
    const ca = aChecks[i]!;
    const cb = bChecks[i]!;
    if (ca.name !== cb.name) return true;
    if (ca.timeoutSec !== cb.timeoutSec) return true;
    if (ca.required !== cb.required) return true;

    const aArgv = ca.argv ?? [];
    const bArgv = cb.argv ?? [];
    if (aArgv.length !== bArgv.length) return true;
    for (let j = 0; j < aArgv.length; j++) {
      if (aArgv[j] !== bArgv[j]) return true;
    }
  }

  const aExcluded = a.excludedPaths ?? [];
  const bExcluded = b.excludedPaths ?? [];
  if (aExcluded.length !== bExcluded.length) return true;
  for (let i = 0; i < aExcluded.length; i++) {
    if (aExcluded[i] !== bExcluded[i]) return true;
  }

  const aLinks = a.dependencyLinks ?? [];
  const bLinks = b.dependencyLinks ?? [];
  if (aLinks.length !== bLinks.length) return true;
  for (let i = 0; i < aLinks.length; i++) {
    if (aLinks[i] !== bLinks[i]) return true;
  }

  return false;
}

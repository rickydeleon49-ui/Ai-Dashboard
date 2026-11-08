/**
 * Shared bounds, caps, and escaping rules for agent prompt builders (§7, §16.2).
 */
import { escapeBlock as claudeEscapeBlock } from "../review-claude";

export const TAIL_CHARS = 2048;
export const MAX_DIFF_FILES = 200;
export const MAX_FINDINGS = 50;
export const MAX_USER_COMMENTS = 50;
export const MAX_SCOPE_PATHS = 200;
export const MAX_ACCEPTANCE = 50;
export const MAX_CHECKS = 20;
export const MAX_ROUNDS = 3;

/**
 * Untrusted text goes inside tagged blocks; literal closing tags in it are defanged.
 * Reuses escapeBlock from review-claude.ts (which handles check_output and changed_files)
 * and defangs all prompt-specific block tags with the same <\/tag pattern.
 */
export function escapeBlock(text: string): string {
  if (typeof text !== "string") return "";
  return claudeEscapeBlock(text).replace(
    /<\/(project_instructions|changed_hint|findings|user_comments|plan|check_output|changed_files)/gi,
    "<\\/$1",
  );
}

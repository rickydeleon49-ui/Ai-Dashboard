import { InvalidMentionError } from "./errors";

export const MAX_MENTIONS_PER_COMMENT = 50;
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUserId(id: string): boolean {
  return UUID_REGEX.test(id);
}

/**
 * Extracts target user IDs from comment text.
 * Supports:
 * - Markdown link mentions: `@[Jane Doe](userId)`
 * - Bare @uuid mentions: `@userId`
 */
export function extractMentions(text: string): string[] {
  const mentions = new Set<string>();

  // Format 1: @[Display Name](userId)
  const markdownRegex = /@\[[^\]]+\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = markdownRegex.exec(text)) !== null) {
    if (match[1]) mentions.add(match[1].trim());
  }

  // Format 2: @<uuid>
  const bareRegex = /@([0-9a-fA-F-]{36})/g;
  while ((match = bareRegex.exec(text)) !== null) {
    if (match[1]) mentions.add(match[1].trim());
  }

  return Array.from(mentions);
}

/**
 * Extracts, deduplicates, and validates mention user IDs against the format and maximum count limits.
 * Rejects invalid UUID formats and counts exceeding 50 before database queries.
 */
export function extractAndValidateMentions(
  body: string,
  explicitMentions?: string[],
): string[] {
  const extracted = extractMentions(body);
  const allMentionIds = Array.from(new Set([...extracted, ...(explicitMentions ?? [])]));

  if (allMentionIds.length > MAX_MENTIONS_PER_COMMENT) {
    throw new InvalidMentionError(
      `A comment cannot mention more than ${MAX_MENTIONS_PER_COMMENT} users.`,
    );
  }

  for (const id of allMentionIds) {
    if (!isValidUserId(id)) {
      throw new InvalidMentionError(
        `Mention target ID is invalid: "${id}". Mentions must reference valid user IDs.`,
        id,
      );
    }
  }

  return allMentionIds;
}

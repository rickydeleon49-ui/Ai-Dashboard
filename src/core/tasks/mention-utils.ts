/**
 * Mention parsing and output sanitization utilities (Release 2C.4).
 */

/**
 * Extracts target user IDs from comment text.
 * Mentions can be formatted as:
 * 1. Markdown mention link: @[DisplayName](userId)
 * 2. Plain UUID mention: @<uuid>
 */
export function extractMentions(text: string): string[] {
  const mentions = new Set<string>();

  // 1. Markdown mention: @[Display Name](userId)
  const markdownRegex = /@\[[^\]]+\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = markdownRegex.exec(text)) !== null) {
    const id = match[1]?.trim();
    if (id) mentions.add(id);
  }

  // 2. Standalone @uuid
  const uuidRegex = /@([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi;
  while ((match = uuidRegex.exec(text)) !== null) {
    if (match[1]) mentions.add(match[1]);
  }

  return Array.from(mentions);
}

/**
 * Escapes HTML characters to prevent XSS.
 * Used when converting raw comment text to safe HTML/text representations.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

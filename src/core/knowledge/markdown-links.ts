/**
 * The link policy for knowledge-document Markdown (Release 2E.1).
 *
 * Every link destination a document contains passes through
 * {@link resolveMarkdownLink} before it can become an `href`. Anything the
 * policy does not positively recognise is refused, and the renderer shows the
 * link text without a destination — refusing is always safe, guessing is not.
 *
 * Allowed:
 *   - `http:` / `https:` URLs with a host and no credentials ("external")
 *   - root-relative in-app paths such as `/projects/abc` ("internal")
 *   - same-page fragments such as `#setup` ("anchor")
 *
 * Refused: every other scheme (`javascript:`, `data:`, `file:`, `vbscript:`,
 * `mailto:`, custom protocols…), protocol-relative `//host`, relative paths
 * (`docs/x`, `../x`), backslashes, ASCII control characters and any
 * whitespace — the last three are how scheme checks are usually smuggled past
 * (`java\tscript:`, `/\evil.example`), and none occur in a legitimate URL.
 *
 * Pure and dependency-free so it can be unit-tested exhaustively and used on
 * both sides of the server/client boundary.
 */

export type MarkdownLink =
  | { kind: "external"; href: string }
  | { kind: "internal"; href: string }
  | { kind: "anchor"; href: string };

/** Longer destinations are refused rather than truncated. */
export const MAX_MARKDOWN_LINK_LENGTH = 2048;

/**
 * Code-point ranges refused anywhere in a destination: ASCII and C1 controls,
 * zero-width and bidirectional formatting characters, line/paragraph
 * separators and the byte-order mark. Listed numerically so the source holds
 * no invisible characters itself.
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x202f],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
];

/** Any whitespace (Unicode included), invisible/control character, or a backslash. */
function hasForbiddenCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code === 0x5c /* backslash */) return true;
    if (/^\s$/u.test(character)) return true;
    if (INVISIBLE_RANGES.some(([low, high]) => code >= low && code <= high)) return true;
  }
  return false;
}

/** Literal, case-insensitive scheme prefix — checked before any parsing. */
const HTTP_PREFIX = /^https?:\/\/[^/]/i;

/** A parse base that can never be a real origin, for resolving in-app paths. */
const INTERNAL_BASE = "https://in-app.invalid";

export function resolveMarkdownLink(raw: string | null | undefined): MarkdownLink | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_MARKDOWN_LINK_LENGTH) return null;
  if (hasForbiddenCharacter(raw)) return null;

  if (raw.startsWith("#")) {
    return { kind: "anchor", href: raw };
  }

  if (raw.startsWith("/")) {
    // `//host` and `/\host` are protocol-relative to a browser. Backslashes
    // were refused above; this refuses the double slash.
    if (raw.startsWith("//")) return null;
    let url: URL;
    try {
      url = new URL(raw, INTERNAL_BASE);
    } catch {
      return null;
    }
    if (url.origin !== INTERNAL_BASE) return null;
    return { kind: "internal", href: url.pathname + url.search + url.hash };
  }

  if (!HTTP_PREFIX.test(raw)) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hostname === "") return null;
  return { kind: "external", href: url.href };
}

/**
 * Knowledge-document Markdown: the single parser configuration that both the
 * renderer (`components/knowledge/markdown-view.tsx`) and plain-text extraction
 * use, so what is searchable is derived from the same tree that is displayed.
 *
 * The source is always stored exactly as written; nothing here rewrites it.
 *
 * Parsing is `unified` + `remark-parse` (micromark, CommonMark) + `remark-gfm`
 * (tables, task lists, strikethrough, autolinks, footnotes). There is no MDX,
 * no plugin or component selection from content, and no step that fetches,
 * reads files or executes anything.
 *
 * ## Complexity guard
 *
 * micromark is not linear for every input. Measured at the 50,000-character
 * limit (bounded subprocess diagnostics, development machine): deeply nested
 * containers (`>>>>…`, `- - - …`, `1. 1. 1. …`) overflow the call stack; tens
 * of thousands of emphasis delimiters take seconds; so do tens of thousands of
 * closing brackets — every link, image, reference, footnote and task-list
 * candidate ends in `]` (`]` × 50,000 ≈ 7 s, `[a](` × 12,499 ≈ 1.8 s) — and
 * thousands of setext heading underlines (`a` / `===` repeated: ≈ 0.3 s at
 * 2,000, ≈ 5 s at 8,000) — and very long lists (12,500 one-character items
 * took over a second each to parse and to render). A cheap, deterministic,
 * linear pre-scan
 * ({@link markdownComplexity}) counts each of those and rejects a document
 * over any budget before parsing. Rejected documents are shown — and
 * searched — as plain text instead. Nothing is lost: plain text is the source
 * itself.
 *
 * The budgets are deliberately conservative counts, not a complexity proof:
 * they count characters anywhere (code blocks included) and were chosen from
 * the measured growth of the constructs above. Ordinary documents are far
 * inside them.
 */
import type { Nodes, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/** The stored-content limit (`core/knowledge/schema.ts` and template documents share it). */
export const KNOWLEDGE_CONTENT_MAX = 50_000;

/** Container nesting (`>` / list markers leading one line, after any indentation) above this is not parsed. */
export const MAX_MARKDOWN_NESTING = 100;

/** `*`, `_` and `~` characters above this are not parsed — the cost of resolving them is superlinear. */
export const MAX_MARKDOWN_DELIMITERS = 4_000;

/**
 * `]` characters above this are not parsed. Every link, image, reference,
 * footnote and task-list candidate is resolved at a closing bracket, and that
 * resolution grows superlinearly with their number.
 */
export const MAX_MARKDOWN_CLOSING_BRACKETS = 2_000;

/**
 * Lines that could be setext heading underlines (`===` / `---`) above this are
 * not parsed — counted inside blockquote and list prefixes too, with LF, CRLF
 * and lone-CR line endings all recognized.
 */
export const MAX_MARKDOWN_SETEXT_UNDERLINES = 500;

/**
 * List-item markers (`-`, `+`, `*`, `1.`, `1)` in a line's leading prefixes, after any
 * indentation) above this are
 * not parsed: 12,500 one-character items took over a second each to parse and
 * to render, roughly growing with their count.
 */
export const MAX_MARKDOWN_LIST_ITEMS = 4_000;

/** Exactly the remark plugins the renderer uses. Fixed here; content can never add to it. */
export const knowledgeRemarkPlugins = [remarkGfm];

export type MarkdownComplexity =
  | { ok: true }
  | {
      ok: false;
      reason: "too-long" | "too-deep" | "too-many-delimiters" | "too-many-brackets" | "too-many-underlines" | "too-many-list-items";
    };

const SPACE = 32;
const TAB = 9;
const GREATER_THAN = 62; // >
const DASH = 45; // -
const PLUS = 43; // +
const ASTERISK = 42; // *
const EQUALS = 61; // =
const DOT = 46; // .
const CLOSE_PAREN = 41; // )
const ZERO = 48;
const NINE = 57;

const isBlank = (code: number) => code === SPACE || code === TAB;

/**
 * Content made only of `=` or only of `-`, with any surrounding spaces/tabs.
 * Deliberately broader than CommonMark's setext underline (which allows at
 * most three spaces of indentation): an indented code line of `===` counts
 * too. Over-counting only ever sends a document to the plain-text fallback.
 */
function isUnderlineContent(line: string, from: number): boolean {
  let i = from;
  while (i < line.length && isBlank(line.charCodeAt(i))) i += 1;
  if (i >= line.length) return false;
  const fill = line.charCodeAt(i);
  if (fill !== EQUALS && fill !== DASH) return false;
  while (i < line.length && line.charCodeAt(i) === fill) i += 1;
  while (i < line.length && isBlank(line.charCodeAt(i))) i += 1;
  return i === line.length;
}

/**
 * One physical line's leading container prefixes: how deep it nests, how many
 * markers start list items, and whether what is left could be a setext
 * underline.
 *
 * Conservative by design (review finding C3): this pre-scan has no Markdown
 * context, so it does NOT apply CommonMark's root-level "at most three spaces
 * of indentation" rule. Inside a list, four, eight or more spaces (or tabs) can
 * be the item's content indentation, followed by a real blockquote or list
 * marker; treating them as code would let nested syntax slip past every
 * container budget. So any run of spaces and tabs may precede each marker:
 *
 *   - `>` (with or without a following space) opens a blockquote level;
 *   - `-`, `+` or `*`, or 1–9 digits then `.` or `)`, followed by a space, a
 *     tab or the end of the line, opens a list item.
 *
 * Each character is examined at most once (plus at most nine digits looked at
 * twice), and the loop stops as soon as the depth budget is exceeded, so the
 * scan stays linear. The price is false positives: indented code that looks
 * like `> quote`, `- item` or `===` is counted as if it were not code, which
 * can only choose the plain-text fallback.
 *
 * A heading inside a blockquote or list item is as costly as one at the root,
 * so the underline test runs on the content after the prefixes. A bare `-` is
 * consumed as a list marker but is also a valid underline under a paragraph,
 * so it counts as both.
 */
function lineContainers(line: string): { depth: number; listMarkers: number; underline: boolean } {
  let depth = 0;
  let listMarkers = 0;
  let lastMarker = 0;
  let i = 0;
  const length = line.length;
  for (;;) {
    while (i < length && isBlank(line.charCodeAt(i))) i += 1;
    if (i >= length) break;
    const code = line.charCodeAt(i);
    if (code === GREATER_THAN) {
      i += 1;
      lastMarker = GREATER_THAN;
    } else if ((code === DASH || code === PLUS || code === ASTERISK) && (i + 1 >= length || isBlank(line.charCodeAt(i + 1)))) {
      i += 1;
      lastMarker = code;
      listMarkers += 1;
    } else if (code >= ZERO && code <= NINE) {
      let j = i;
      while (j < length && j - i < 9 && line.charCodeAt(j) >= ZERO && line.charCodeAt(j) <= NINE) j += 1;
      const delimiter = line.charCodeAt(j);
      if ((delimiter !== DOT && delimiter !== CLOSE_PAREN) || !(j + 1 >= length || isBlank(line.charCodeAt(j + 1)))) break;
      i = j + 1;
      lastMarker = delimiter;
      listMarkers += 1;
    } else {
      break;
    }
    depth += 1;
    if (depth > MAX_MARKDOWN_NESTING) break;
  }
  const underline = isUnderlineContent(line, i) || (i >= length && lastMarker === DASH);
  return { depth, listMarkers, underline };
}

/**
 * Whether `source` is safe to hand to the parser. Linear in the input length
 * and independent of machine speed, so the same document always takes the
 * same path on every server, desktop and test run.
 */
export function markdownComplexity(source: string): MarkdownComplexity {
  if (source.length > KNOWLEDGE_CONTENT_MAX) return { ok: false, reason: "too-long" };

  let delimiters = 0;
  let closingBrackets = 0;
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    if (code === 42 /* * */ || code === 95 /* _ */ || code === 126 /* ~ */) {
      delimiters += 1;
      if (delimiters > MAX_MARKDOWN_DELIMITERS) return { ok: false, reason: "too-many-delimiters" };
    } else if (code === 93 /* ] */) {
      closingBrackets += 1;
      if (closingBrackets > MAX_MARKDOWN_CLOSING_BRACKETS) return { ok: false, reason: "too-many-brackets" };
    }
  }

  // Lines end at LF, CRLF or a lone CR — every line ending CommonMark
  // recognizes, in any mix — so a CR-only document is scanned line by line
  // exactly as the parser will read it. The source itself is never altered.
  let underlines = 0;
  let listItems = 0;
  let start = 0;
  const length = source.length;
  for (;;) {
    let end = start;
    while (end < length) {
      const code = source.charCodeAt(end);
      if (code === 10 /* LF */ || code === 13 /* CR */) break;
      end += 1;
    }
    const containers = lineContainers(source.slice(start, end));
    if (containers.depth > MAX_MARKDOWN_NESTING) return { ok: false, reason: "too-deep" };
    listItems += containers.listMarkers;
    if (listItems > MAX_MARKDOWN_LIST_ITEMS) return { ok: false, reason: "too-many-list-items" };
    if (containers.underline) {
      underlines += 1;
      if (underlines > MAX_MARKDOWN_SETEXT_UNDERLINES) return { ok: false, reason: "too-many-underlines" };
    }
    if (end >= length) break;
    // CRLF is one line ending, not two.
    start = source.charCodeAt(end) === 13 && source.charCodeAt(end + 1) === 10 ? end + 2 : end + 1;
  }

  return { ok: true };
}

/**
 * The one parser used for extraction and search. Exported so tests can count
 * real parse calls and prove the guard keeps refused documents away from it.
 */
export const knowledgeMarkdownProcessor = unified().use(remarkParse).use(knowledgeRemarkPlugins).freeze();
const processor = knowledgeMarkdownProcessor;

/**
 * The document's Markdown tree, or null when it must be treated as plain text
 * (the complexity guard refused it, or the parser failed on it).
 */
export function parseKnowledgeMarkdown(source: string): Root | null {
  if (!markdownComplexity(source).ok) return null;
  try {
    return processor.parse(source);
  } catch {
    return null;
  }
}

/** Nodes whose text is part of the surrounding line rather than a block of its own. */
const INLINE_TYPES = new Set([
  "text",
  "emphasis",
  "strong",
  "delete",
  "inlineCode",
  "break",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "footnoteReference",
  "html",
]);

function collectInline(node: Nodes, out: string[]): void {
  switch (node.type) {
    case "text":
    case "inlineCode":
      out.push(node.value);
      return;
    case "break":
      out.push("\n");
      return;
    // The renderer shows an image's alt text in place of the image, so that is
    // what is searchable — never its URL.
    case "image":
    case "imageReference":
      if (node.alt) out.push(node.alt);
      return;
    // Raw HTML markup is not indexed; footnote references render as a number.
    case "html":
    case "footnoteReference":
      return;
    default:
      if ("children" in node) for (const child of node.children) collectInline(child as Nodes, out);
  }
}

function collectBlocks(node: Nodes, lines: string[]): void {
  switch (node.type) {
    case "code":
      if (node.value) lines.push(node.value);
      return;
    // Link reference definitions are invisible; their destinations are not text.
    case "definition":
    case "html":
    case "thematicBreak":
      return;
    case "tableRow": {
      const cells = node.children.map((cell) => {
        const out: string[] = [];
        for (const child of cell.children) collectInline(child as Nodes, out);
        return out.join("").trim();
      });
      const row = cells.filter(Boolean).join(" ");
      if (row) lines.push(row);
      return;
    }
    default:
      break;
  }

  if (!("children" in node)) return;

  // A run of inline children is one line of text; block children recurse.
  let inline: string[] = [];
  const flush = () => {
    const text = inline.join("").trim();
    if (text) lines.push(text);
    inline = [];
  };
  for (const child of node.children as Nodes[]) {
    if (INLINE_TYPES.has(child.type)) {
      collectInline(child, inline);
    } else {
      flush();
      collectBlocks(child, lines);
    }
  }
  flush();
}

/**
 * The visible text of a document — headings, prose, list and task-list items,
 * table cells, link labels, image alt text and code — one block per line, from
 * the same tree the renderer displays. Raw HTML markup, link and image
 * destinations and reference definitions are excluded.
 *
 * Deterministic. A document the complexity guard refuses is returned as its
 * own source text, because that is exactly how it is displayed.
 */
export function extractPlainText(source: string): string {
  const tree = parseKnowledgeMarkdown(source);
  if (!tree) return source.replace(/\r\n?/g, "\n").trim();
  const lines: string[] = [];
  collectBlocks(tree, lines);
  return lines.join("\n");
}

/** How much of a document's source a list summary may parse. */
export const SUMMARY_SOURCE_PREFIX = 2_000;

/**
 * A one-line summary of at most `max` characters, for list cards.
 *
 * Bounded by input, not just output: only the first
 * {@link SUMMARY_SOURCE_PREFIX} characters of the source are ever parsed, so a
 * list of long documents costs the same as a list of short ones. The full
 * document's guard decision still applies first — a document readers see as
 * plain text is summarized as plain text too.
 *
 * Truncation semantics: the summary reflects the start of the document only.
 * A construct cut at the prefix boundary is summarized as far as it got (an
 * unfinished link shows its label or literal brackets; a reference whose
 * definition comes later shows its label in brackets; an unclosed code fence
 * contributes its code text). A split surrogate pair at the boundary is
 * dropped. Search and the document page always use the whole document.
 */
export function summarizeMarkdown(source: string, max = 280): string {
  const truncated = source.length > SUMMARY_SOURCE_PREFIX;
  let prefix = truncated ? source.slice(0, SUMMARY_SOURCE_PREFIX) : source;
  const last = prefix.charCodeAt(prefix.length - 1);
  if (truncated && last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);

  const text = markdownComplexity(source).ok ? extractPlainText(prefix) : prefix;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max || (truncated && flat.length > 0)
    ? `${flat.slice(0, max - 1).trimEnd()}…`
    : flat;
}

/**
 * Case- and whitespace-folding used on both sides of a search: the stored key
 * and the query. `toLowerCase` (not the locale variant) keeps it identical on
 * every machine and both database backends.
 */
export function normalizeForSearch(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The derived `search_text` column: the title, category and visible document
 * text, normalized. Searching compares a normalized query against this alone,
 * so SQLite and PostgreSQL match exactly the same documents.
 */
export function buildKnowledgeSearchText(document: {
  title: string;
  category: string | null | undefined;
  content: string;
}): string {
  return normalizeForSearch(
    [document.title, document.category ?? "", extractPlainText(document.content)].join("\n"),
  );
}

/**
 * A `LIKE` pattern matching `query` anywhere, with `%`, `_` and the escape
 * character itself escaped — use with `ESCAPE '\'`. A search for "100%" means
 * the text "100%", not "100 followed by anything".
 */
export function searchLikePattern(query: string): string {
  const escaped = normalizeForSearch(query).replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

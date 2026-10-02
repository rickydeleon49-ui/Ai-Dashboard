/**
 * Release 2E.1 — Safe Markdown, the pure pieces:
 *   1. the link policy (`resolveMarkdownLink`), exhaustively;
 *   2. the complexity guard and its exact boundaries;
 *   3. plain-text extraction and the derived search key;
 *   4. server rendering of `MarkdownView` for every supported construct and a
 *      corpus of stored-XSS payloads.
 *
 * The rendered-DOM, execution and network assertions live in the browser
 * suites (tests/e2e/knowledge-markdown.test.ts and the accounts/desktop
 * suites); here the renderer's output is checked structurally as markup.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { resolveMarkdownLink } from "../../src/core/knowledge/markdown-links";
import {
  KNOWLEDGE_CONTENT_MAX,
  MAX_MARKDOWN_DELIMITERS,
  MAX_MARKDOWN_NESTING,
  MAX_MARKDOWN_CLOSING_BRACKETS,
  MAX_MARKDOWN_SETEXT_UNDERLINES,
  MAX_MARKDOWN_LIST_ITEMS,
  SUMMARY_SOURCE_PREFIX,
  knowledgeMarkdownProcessor,
  parseKnowledgeMarkdown,
  buildKnowledgeSearchText,
  extractPlainText,
  markdownComplexity,
  normalizeForSearch,
  searchLikePattern,
  summarizeMarkdown,
} from "../../src/core/knowledge/markdown";
import { knowledgeDocumentCreateSchema, knowledgeDocumentUpdateSchema } from "../../src/core/knowledge/schema";
import { STORED_XSS_PAYLOADS, assertInertMarkup, renderMarkdownBatch } from "../helpers/markdown-fixtures";

const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const NL = String.fromCharCode(10);
const lines = (...parts: string[]) => parts.join(NL);

/*
 * Every source the render assertions need, rendered once in a child process
 * before the tests run (see tests/helpers/render-markdown-cli.tsx).
 */
const toRender: Record<string, string> = {};
function queue(key: string, source: string): void {
  toRender[key] = source;
}
let rendered: Record<string, string> = {};
function html(key: string): string {
  const out = rendered[key];
  assert.equal(typeof out, "string", `no render for ${key}`);
  return out!;
}

const hostile = [
  ">".repeat(KNOWLEDGE_CONTENT_MAX),
  "1. ".repeat(Math.floor(KNOWLEDGE_CONTENT_MAX / 3)),
  "- ".repeat(KNOWLEDGE_CONTENT_MAX / 2),
  "*a".repeat(KNOWLEDGE_CONTENT_MAX / 2),
  "~~a".repeat(Math.floor(KNOWLEDGE_CONTENT_MAX / 3)),
  `${"*".repeat(KNOWLEDGE_CONTENT_MAX / 2)}a${"*".repeat(KNOWLEDGE_CONTENT_MAX / 2 - 1)}`,
];
hostile.forEach((source, index) => queue(`hostile-${index}`, source));

const realisticSection = lines(
  "## Section heading",
  "",
  "Some **bold** prose with `inline code` and a [link](https://example.com/docs).",
  "",
  "- [x] done item",
  "- [ ] open item",
  "",
  "| Key | Value |",
  "| --- | ----- |",
  "| a   | 1     |",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "",
);
let realistic = "";
while (realistic.length + realisticSection.length <= KNOWLEDGE_CONTENT_MAX) realistic += realisticSection;
queue("realistic", realistic);

const malformedSources = [
  "**unclosed bold",
  "[broken](",
  lines("| a | b", "|--"),
  lines("```", "never closed"),
  "<div",
  "[^missing]",
];
malformedSources.forEach((source, index) => queue(`malformed-${index}`, source));

queue(
  "constructs",
  lines(
    "# Title",
    "## Sub",
    "",
    "- one",
    "- two",
    "",
    "1. first",
    "",
    "- [x] done",
    "- [ ] open",
    "",
    "| A | B |",
    "|---|--:|",
    "| 1 | 2 |",
    "",
    "```js",
    "const x = 1 < 2;",
    "```",
    "",
    "Inline `code`, *em*, **strong**, ~~gone~~.",
    "",
    "[ext](https://example.com) [app](/projects) [here](#top) www.example.org",
  ),
);
queue(
  "images",
  lines(
    "![Architecture diagram](https://tracker.example/pixel.png)",
    "",
    "![](data:image/png;base64,AAAA)",
    "",
    "![ref][r]",
    "",
    "[r]: https://tracker.example/r.png",
  ),
);
queue("refused", "[click](javascript:alert(1)) [file](file:///etc/passwd) [proto](//evil.example)");
queue("empty", "");
for (const [name, payload] of Object.entries(STORED_XSS_PAYLOADS)) queue(`xss-${name}`, payload);


describe("link policy", () => {
  const allowed: [string, string, string][] = [
    ["https://example.com/a?b=1#c", "external", "https://example.com/a?b=1#c"],
    ["http://example.com", "external", "http://example.com/"],
    ["HTTPS://EXAMPLE.COM/Path", "external", "https://example.com/Path"],
    [`https://${cp(0x4f8b, 0x3048)}.jp/${cp(0x30d1, 0x30b9)}`, "external", "https://xn--r8jz45g.jp/%E3%83%91%E3%82%B9"],
    ["https://example.com:8443/x", "external", "https://example.com:8443/x"],
    ["/projects/abc", "internal", "/projects/abc"],
    ["/projects/abc/knowledge?search=x#top", "internal", "/projects/abc/knowledge?search=x#top"],
    ["/%2F%2Fevil.example", "internal", "/%2F%2Fevil.example"],
    ["#setup", "anchor", "#setup"],
    ["#user-content-fn-1", "anchor", "#user-content-fn-1"],
  ];
  for (const [raw, kind, href] of allowed) {
    it(`allows ${JSON.stringify(raw)} as ${kind}`, () => {
      assert.deepEqual(resolveMarkdownLink(raw), { kind, href });
    });
  }

  const backslash = String.fromCharCode(92);
  const refused: [string, string][] = [
    ["javascript:alert(1)", "javascript scheme"],
    ["JaVaScRiPt:alert(1)", "mixed-case javascript"],
    [`java${cp(9)}script:alert(1)`, "tab inside the scheme"],
    [`java${cp(10)}script:alert(1)`, "newline inside the scheme"],
    [" javascript:alert(1)", "leading space"],
    [`${cp(0)}javascript:alert(1)`, "leading NUL"],
    [`${cp(0x200b)}javascript:alert(1)`, "leading zero-width space"],
    [`${cp(0xfeff)}https://example.com`, "leading byte-order mark"],
    [`https://exa${cp(0x200b)}mple.com`, "zero-width space in host"],
    [`https://example.com/${cp(0x202e)}gpj.exe`, "right-to-left override"],
    [`https://example.com/${cp(0x2028)}`, "line separator"],
    [`https://example.com/${cp(0x85)}`, "C1 control"],
    ["https://example.com/a b", "space in path"],
    [`https://example.com/a${cp(0x3000)}b`, "ideographic space"],
    ["data:text/html,<script>alert(1)</script>", "data scheme"],
    ["file:///etc/passwd", "file scheme"],
    ["vbscript:msgbox(1)", "vbscript scheme"],
    ["mailto:someone@example.com", "mailto scheme"],
    ["ftp://example.com/x", "ftp scheme"],
    ["ws://example.com", "websocket scheme"],
    ["chrome://settings", "browser-internal scheme"],
    ["about:blank", "about scheme"],
    ["blob:https://example.com/uuid", "blob scheme"],
    ["//evil.example/x", "protocol-relative"],
    [`/${backslash}evil.example`, "slash-backslash"],
    [`${backslash}${backslash}evil.example${backslash}share`, "UNC path"],
    [`https:${backslash}${backslash}evil.example`, "backslash after scheme"],
    ["https:/evil.example", "single slash after scheme"],
    ["https://user:pass@example.com/", "credentials"],
    ["https://user@example.com/", "username only"],
    ["http://", "no host"],
    ["docs/page", "relative path"],
    ["./page", "dot-relative path"],
    ["../page", "parent-relative path"],
    ["example.com", "bare host"],
    ["", "empty"],
    [`https://example.com/${"a".repeat(2100)}`, "over the length limit"],
  ];
  for (const [raw, why] of refused) {
    it(`refuses ${why}`, () => {
      assert.equal(resolveMarkdownLink(raw), null);
    });
  }

  it("refuses non-strings", () => {
    assert.equal(resolveMarkdownLink(undefined), null);
    assert.equal(resolveMarkdownLink(null), null);
  });
});

describe("complexity guard", () => {
  it("accepts the 50,000-character limit and refuses one more", () => {
    const atLimit = "word ".repeat(KNOWLEDGE_CONTENT_MAX / 5);
    assert.equal(atLimit.length, KNOWLEDGE_CONTENT_MAX);
    assert.deepEqual(markdownComplexity(atLimit), { ok: true });
    assert.deepEqual(markdownComplexity(`${atLimit}x`), { ok: false, reason: "too-long" });
  });

  it("refuses more than the delimiter budget, at the exact boundary", () => {
    assert.deepEqual(markdownComplexity("*".repeat(MAX_MARKDOWN_DELIMITERS)), { ok: true });
    assert.deepEqual(markdownComplexity("_".repeat(MAX_MARKDOWN_DELIMITERS + 1)), {
      ok: false,
      reason: "too-many-delimiters",
    });
  });

  it("refuses container nesting beyond the limit, at the exact boundary", () => {
    assert.deepEqual(markdownComplexity(`${">".repeat(MAX_MARKDOWN_NESTING)} x`), { ok: true });
    assert.deepEqual(markdownComplexity(`${">".repeat(MAX_MARKDOWN_NESTING + 1)} x`), { ok: false, reason: "too-deep" });
    assert.deepEqual(markdownComplexity(`${"- ".repeat(MAX_MARKDOWN_NESTING + 1)}x`), { ok: false, reason: "too-deep" });
    assert.deepEqual(markdownComplexity(`${"1. ".repeat(MAX_MARKDOWN_NESTING + 1)}x`), { ok: false, reason: "too-deep" });
  });

  it("turns every input that crashed or stalled the parser into the plain-text path, quickly", () => {
    hostile.forEach((source, index) => {
      const started = performance.now();
      const text = extractPlainText(source);
      const elapsed = performance.now() - started;
      assert.match(html(`hostile-${index}`), /data-markdown-mode="plain"/);
      assert.equal(text, source.trim());
      assert.ok(elapsed < 2_000, `fallback took ${elapsed.toFixed(0)}ms`);
    });
  });

  it("formats a realistic 50,000-character document within the guard", () => {
    assert.ok(realistic.length > KNOWLEDGE_CONTENT_MAX - realisticSection.length);
    assert.ok(markdownComplexity(realistic).ok, "a realistic long document must be formatted, not refused");
    assert.doesNotMatch(html("realistic"), /data-markdown-mode="plain"/);
    assert.match(html("realistic"), /<table>/);
  });
});

describe("plain-text extraction", () => {
  const document = lines(
    "# Deploy runbook",
    "",
    "Run the **release** script with `npm run release`.",
    "",
    "- [x] Tag the build",
    "- [ ] Announce it",
    "",
    "| Step | Owner |",
    "| ---- | ----- |",
    "| Ship | Ana   |",
    "",
    "```sh",
    "./deploy --prod",
    "```",
    "",
    "See [the guide](https://secret-destination.example/path) and ![diagram](https://tracker.example/pixel.png).",
    "",
    "Raw <b>bold</b> and <script>alert('x')</script> markup.",
    "",
    "[ref]: https://hidden-reference.example/",
    "",
    "Footnote here[^1].",
    "",
    "[^1]: The footnote text.",
  );

  const text = extractPlainText(document);

  it("keeps visible headings, prose, task items, table cells, code, labels and alt text", () => {
    for (const expected of [
      "Deploy runbook",
      "Run the release script with npm run release.",
      "Tag the build",
      "Announce it",
      "Step Owner",
      "Ship Ana",
      "./deploy --prod",
      "the guide",
      "diagram",
      "bold",
      "The footnote text.",
    ]) {
      assert.ok(text.includes(expected), `missing ${JSON.stringify(expected)} in:${NL}${text}`);
    }
  });

  it("drops destinations, image URLs, reference definitions and raw HTML markup", () => {
    // Inline raw HTML tags are separate nodes: "<script>" is markup (dropped),
    // but the text between the tags is ordinary visible text (kept, and shown
    // literally by the renderer), so it is searchable like any other text.
    assert.ok(text.includes("alert('x')"));
    for (const hidden of ["secret-destination", "tracker.example", "hidden-reference", "<b>", "</b>", "<script>", "**", "]("]) {
      assert.ok(!text.includes(hidden), `${JSON.stringify(hidden)} leaked into:${NL}${text}`);
    }
  });

  it("is deterministic", () => {
    assert.equal(extractPlainText(document), text);
  });

  it("handles empty, plain-text, Unicode and malformed documents", () => {
    assert.equal(extractPlainText(""), "");
    assert.equal(extractPlainText(`   ${NL}${NL} `), "");
    assert.equal(extractPlainText("just some words"), "just some words");
    const unicode = `Caf${cp(0xe9)} ${cp(0x6771, 0x4eac)} ${cp(0x1f680)} ${cp(0x0645, 0x0631, 0x062d, 0x0628, 0x0627)}`;
    assert.equal(extractPlainText(`## ${unicode}`), unicode);
    malformedSources.forEach((malformed, index) => {
      assert.doesNotThrow(() => extractPlainText(malformed));
      assert.doesNotMatch(html(`malformed-${index}`), /data-markdown-mode="plain"/);
    });
    assert.ok(extractPlainText("**unclosed bold").includes("unclosed bold"));
  });

  it("summarizes on one line and truncates", () => {
    assert.equal(summarizeMarkdown(lines("# Title", "", "Body *text*.")), "Title Body text.");
    const long = summarizeMarkdown("word ".repeat(200), 50);
    assert.equal(long.length, 50);
    assert.ok(long.endsWith(cp(0x2026)));
  });
});

describe("search key and pattern", () => {
  it("folds case (Unicode included), whitespace and composition", () => {
    assert.equal(normalizeForSearch(`  CAF${cp(0xc9)}${NL}${cp(9)}Notes `), `caf${cp(0xe9)} notes`);
    // "e" + combining acute normalizes to the precomposed character.
    assert.equal(normalizeForSearch(`cafe${cp(0x301)}`), `caf${cp(0xe9)}`);
  });

  it("covers title, category and visible text only", () => {
    const key = buildKnowledgeSearchText({
      title: "Runbook",
      category: "Ops",
      content: "Use [the portal](https://portal.internal.example) **today**.",
    });
    assert.equal(key, "runbook ops use the portal today.");
  });

  it("escapes LIKE wildcards and the escape character", () => {
    const b = String.fromCharCode(92);
    assert.equal(searchLikePattern("100%"), `%100${b}%%`);
    assert.equal(searchLikePattern("snake_case"), `%snake${b}_case%`);
    assert.equal(searchLikePattern(`a${b}b`), `%a${b}${b}b%`);
    assert.equal(searchLikePattern("  Mixed CASE "), "%mixed case%");
  });
});

describe("content limits", () => {
  it("accepts exactly 50,000 characters and refuses 50,001 on create and update", () => {
    const ok = "x".repeat(KNOWLEDGE_CONTENT_MAX);
    assert.equal(knowledgeDocumentCreateSchema.safeParse({ title: "t", content: ok }).success, true);
    assert.equal(knowledgeDocumentCreateSchema.safeParse({ title: "t", content: `${ok}x` }).success, false);
    assert.equal(knowledgeDocumentUpdateSchema.safeParse({ content: ok }).success, true);
    assert.equal(knowledgeDocumentUpdateSchema.safeParse({ content: `${ok}x` }).success, false);
  });
});

describe("MarkdownView (server render)", () => {
  it("renders headings one level down, lists, task lists, tables, code and links", () => {
    const out = html("constructs");
    assert.match(out, /<h2>Title<\/h2>/);
    assert.match(out, /<h3>Sub<\/h3>/);
    assert.doesNotMatch(out, /<h1/);
    assert.match(out, /<ul>[\s\S]*<li>one<\/li>/);
    assert.match(out, /<ol>/);
    assert.match(out, /<input type="checkbox" disabled="" readOnly="" aria-label="Completed" checked=""\/>/);
    assert.match(out, /<input type="checkbox" disabled="" readOnly="" aria-label="Not completed"\/>/);
    assert.match(out, /<div class="markdown-table" role="region" aria-label="Table" tabindex="0"><table>/);
    assert.match(out, /<td style="text-align:right">2<\/td>/);
    assert.match(out, /<pre tabindex="0"><code class="language-js">const x = 1 &lt; 2;\s*<\/code><\/pre>/);
    assert.match(out, /<del>gone<\/del>/);
    assert.match(
      out,
      /<a href="https:\/\/example.com\/" target="_blank" rel="noopener noreferrer nofollow ugc" referrerPolicy="no-referrer" data-markdown-link="external">ext<\/a>/,
    );
    assert.match(out, /<a href="\/projects" data-markdown-link="internal">app<\/a>/);
    assert.match(out, /<a href="#top" data-markdown-link="anchor">here<\/a>/);
    assert.match(out, /<a href="http:\/\/www.example.org\/"[^>]*data-markdown-link="external">www.example.org<\/a>/);
    assertInertMarkup(out, "constructs");
  });

  it("never loads an image: alt text instead, no src anywhere", () => {
    const out = html("images");
    assert.doesNotMatch(out, /<img/i);
    assert.doesNotMatch(out, /src=/i);
    assert.doesNotMatch(out, /tracker\.example|data:image/);
    assert.match(out, /\[Image: Architecture diagram\]/);
    assert.match(out, /\[Image: image\]/);
    assert.match(out, /\[Image: ref\]/);
  });

  it("keeps refused links as text with no destination", () => {
    const out = html("refused");
    assert.equal((out.match(/data-markdown-link="refused"/g) ?? []).length, 3);
    assert.doesNotMatch(out, /href=/);
    assert.match(out, />click</);
  });

  it("shows an empty document as a placeholder", () => {
    assert.match(html("empty"), /No content yet\./);
  });

  for (const name of Object.keys(STORED_XSS_PAYLOADS)) {
    it(`renders the ${name} payload inert`, () => {
      assertInertMarkup(html(`xss-${name}`), name);
    });
  }
});

/*
 * Review finding M1: valid-size documents whose cost was not covered by the
 * guard. Parser avoidance is asserted by counting real parse calls on the
 * shared processor, never by timing.
 */
const REVIEW_PAYLOAD = "[a](".repeat(12499);
const costlyInputs: Record<string, string> = {
  reviewPayload: REVIEW_PAYLOAD,
  closingBrackets: "]".repeat(KNOWLEDGE_CONTENT_MAX),
  doubleClosing: "]]".repeat(KNOWLEDGE_CONTENT_MAX / 2),
  shortcutReferences: "[a]".repeat(Math.floor(KNOWLEDGE_CONTENT_MAX / 3)),
  fullReferences: "[a][".repeat(Math.floor(KNOWLEDGE_CONTENT_MAX / 4)),
  definitions: "[a]: ".repeat(Math.floor(KNOWLEDGE_CONTENT_MAX / 5)),
  images: "![a](".repeat(Math.floor(KNOWLEDGE_CONTENT_MAX / 5)),
  setextHeadings: lines(...Array.from({ length: 12_000 }, (_, i) => (i % 2 ? "=" : "a"))).slice(0, KNOWLEDGE_CONTENT_MAX),
  setextDashes: lines(...Array.from({ length: 12_000 }, (_, i) => (i % 2 ? "-" : "a"))).slice(0, KNOWLEDGE_CONTENT_MAX),
  listItems: lines(...Array.from({ length: 12_499 }, () => "- a")),
};
for (const [name, source] of Object.entries(costlyInputs)) queue(`costly-${name}`, source);

const ordinaryMarkdown = lines(
  "# Links, images and references",
  "",
  "Inline [docs](https://example.com/docs), autolink <https://example.com>, www.example.org,",
  "an image ![diagram](https://example.com/d.png), a [reference][ref] and a [collapsed][] one.",
  "",
  "Literal brackets stay text: array[0], [not a link], [x] and a lone ] or [.",
  "",
  "- [x] done",
  "- [ ] open",
  "",
  "| a | b |",
  "|---|---|",
  "| [cell](/projects) | `code]` |",
  "",
  "Setext heading",
  "==============",
  "",
  "```js",
  "const xs = [1, 2, 3][0];",
  "```",
  "",
  `Unicode ${cp(0x6771, 0x4eac)} [${cp(0x30ea, 0x30f3, 0x30af)}](https://example.com/${cp(0x30d1)}) footnote[^1].`,
  "",
  "[ref]: https://example.com/ref",
  "[collapsed]: /projects",
  "[^1]: Note.",
);
queue("ordinary", ordinaryMarkdown);

/** Calls `fn` while counting (and measuring the input of) real parse calls. */
function countingParses<T>(fn: () => T): { result: T; parses: number[] } {
  const parses: number[] = [];
  const original = knowledgeMarkdownProcessor.parse;
  knowledgeMarkdownProcessor.parse = ((file?: unknown) => {
    parses.push(String(file ?? "").length);
    return original.call(knowledgeMarkdownProcessor, file as string);
  }) as typeof original;
  try {
    return { result: fn(), parses };
  } finally {
    knowledgeMarkdownProcessor.parse = original;
  }
}

/** True when a high surrogate is left without its low half. */
function hasLoneHighSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    }
  }
  return false;
}

describe("review M1: costly valid-size Markdown never reaches the parser", () => {
  it("refuses the exact review payload before parsing, everywhere it is used", () => {
    assert.equal(REVIEW_PAYLOAD.length, 49_996);
    assert.ok(REVIEW_PAYLOAD.length <= KNOWLEDGE_CONTENT_MAX, "the payload is a valid document size");
    assert.deepEqual(markdownComplexity(REVIEW_PAYLOAD), { ok: false, reason: "too-many-brackets" });

    const { result, parses } = countingParses(() => ({
      text: extractPlainText(REVIEW_PAYLOAD),
      key: buildKnowledgeSearchText({ title: "T", category: null, content: REVIEW_PAYLOAD }),
      summary: summarizeMarkdown(REVIEW_PAYLOAD),
      tree: parseKnowledgeMarkdown(REVIEW_PAYLOAD),
    }));
    assert.deepEqual(parses, [], "the parser was never invoked");
    assert.equal(result.text, REVIEW_PAYLOAD, "plain text is the source, verbatim");
    assert.equal(result.tree, null);
    assert.ok(result.key.startsWith("t [a]([a]("));
    assert.equal(result.summary.length, 280);

    const out = html("costly-reviewPayload");
    assert.match(out, /data-markdown-mode="plain"/);
    assert.match(out, /<pre class="markdown-plain">\[a\]\(\[a\]\(/);
    assertInertMarkup(out, "review payload");
  });

  for (const [name, source] of Object.entries(costlyInputs)) {
    it(`sends ${name} (${source.length} chars) to the plain-text fallback without parsing`, () => {
      assert.ok(source.length <= KNOWLEDGE_CONTENT_MAX);
      assert.equal(markdownComplexity(source).ok, false);
      const { result, parses } = countingParses(() => extractPlainText(source));
      assert.deepEqual(parses, []);
      assert.equal(result, source.trim());
      assert.match(html(`costly-${name}`), /data-markdown-mode="plain"/);
    });
  }

  it("enforces the bracket, setext and list budgets at their exact boundaries", () => {
    assert.deepEqual(markdownComplexity("]".repeat(MAX_MARKDOWN_CLOSING_BRACKETS)), { ok: true });
    assert.deepEqual(markdownComplexity("]".repeat(MAX_MARKDOWN_CLOSING_BRACKETS + 1)), {
      ok: false,
      reason: "too-many-brackets",
    });
    const headings = (n: number) => lines(...Array.from({ length: n }, () => lines("a", "===")));
    assert.deepEqual(markdownComplexity(headings(MAX_MARKDOWN_SETEXT_UNDERLINES)), { ok: true });
    assert.deepEqual(markdownComplexity(headings(MAX_MARKDOWN_SETEXT_UNDERLINES + 1)), {
      ok: false,
      reason: "too-many-underlines",
    });
    // Thematic breaks look like underlines and are counted too — conservative by design.
    assert.deepEqual(markdownComplexity(lines(...Array.from({ length: MAX_MARKDOWN_SETEXT_UNDERLINES + 1 }, () => "---"))), {
      ok: false,
      reason: "too-many-underlines",
    });
    // List markers: bullets and ordered markers both count; quotes do not.
    const items = (n: number) => lines(...Array.from({ length: n }, (_, i) => (i % 2 ? "1. a" : "- a")));
    assert.deepEqual(markdownComplexity(items(MAX_MARKDOWN_LIST_ITEMS)), { ok: true });
    assert.deepEqual(markdownComplexity(items(MAX_MARKDOWN_LIST_ITEMS + 1)), { ok: false, reason: "too-many-list-items" });
    assert.deepEqual(markdownComplexity(lines(...Array.from({ length: MAX_MARKDOWN_LIST_ITEMS + 1 }, () => "> a"))), { ok: true });
    // Indented four spaces is code to CommonMark, but the scan counts it anyway
    // (review C1: underlines are counted inside any prefix) — a deliberate,
    // documented over-count that can only choose the plain-text fallback.
    assert.deepEqual(markdownComplexity(lines(...Array.from({ length: MAX_MARKDOWN_SETEXT_UNDERLINES + 1 }, () => "    ==="))), {
      ok: false,
      reason: "too-many-underlines",
    });
  });

  it("keeps ordinary links, images, references, GFM, code, Unicode and literal brackets formatted", () => {
    assert.deepEqual(markdownComplexity(ordinaryMarkdown), { ok: true });
    const { result, parses } = countingParses(() => extractPlainText(ordinaryMarkdown));
    assert.equal(parses.length, 1, "an ordinary document is parsed, once");
    for (const expected of [
      "docs",
      "diagram",
      "reference",
      "collapsed",
      "array[0], [not a link], [x] and a lone ] or [.",
      "Setext heading",
      "const xs = [1, 2, 3][0];",
      "Note.",
    ]) {
      assert.ok(result.includes(expected), `missing ${JSON.stringify(expected)} in:${NL}${result}`);
    }
    const out = html("ordinary");
    assert.doesNotMatch(out, /data-markdown-mode="plain"/);
    assert.match(out, /<a href="https:\/\/example.com\/ref" [^>]*>reference<\/a>/);
    assert.match(out, /<a href="\/projects" data-markdown-link="internal">collapsed<\/a>/);
    assert.match(out, /\[Image: diagram\]/);
    assert.match(out, /<h2>Setext heading<\/h2>/);
    assert.match(out, /<td><a href="\/projects" data-markdown-link="internal">cell<\/a><\/td>/);
    assertInertMarkup(out, "ordinary");
  });
});

describe("review M1: list summaries parse a bounded prefix", () => {
  it("parses at most the summary prefix of a long, valid document", () => {
    assert.ok(markdownComplexity(realistic).ok);
    const { result, parses } = countingParses(() => summarizeMarkdown(realistic));
    assert.equal(parses.length, 1);
    assert.ok(parses[0]! <= SUMMARY_SOURCE_PREFIX, `parsed ${parses[0]} characters`);
    assert.ok(result.length <= 280);
    assert.ok(result.startsWith("Section heading Some bold prose"), result);
    assert.ok(result.endsWith(cp(0x2026)), "a truncated summary says so");
  });

  it("summarizes a refused document as plain text without parsing", () => {
    const { result, parses } = countingParses(() => summarizeMarkdown(costlyInputs.setextHeadings!));
    assert.deepEqual(parses, []);
    assert.ok(result.startsWith("a = a = a"), result);
  });

  it("documents its truncation semantics at the boundary", () => {
    const filler = "x".repeat(SUMMARY_SOURCE_PREFIX - 10);
    // A link cut at the boundary contributes its label text, never the rest of its URL.
    const cut = summarizeMarkdown(`${filler} [label](https://example.com/very/long/destination)`, 5_000);
    assert.ok(!cut.includes("destination"), cut.slice(-40));
    // A split surrogate pair at the boundary is dropped rather than kept half.
    const split = summarizeMarkdown(`${"y".repeat(SUMMARY_SOURCE_PREFIX - 1)}${cp(0x1f680)}tail`, 5_000);
    assert.equal(hasLoneHighSurrogate(split), false);
    // A short document is not marked as truncated.
    assert.equal(summarizeMarkdown("Short note."), "Short note.");
  });
});

/*
 * Review finding C1: setext underlines inside containers, and under CR / CRLF
 * line endings, bypassed the underline budget. Each form below is built with
 * `n` heading/underline pairs and each supported line ending.
 */
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const CRLF = CR + LF;
const LINE_ENDINGS: Record<string, string> = { LF, CRLF, CR };

/** n heading + underline pairs in the given form, joined by `eol`. */
const underlineForms: Record<string, (n: number, eol: string) => string> = {
  root: (n, eol) => Array.from({ length: n }, () => `a${eol}=${eol}`).join(""),
  quoted: (n, eol) => Array.from({ length: n }, () => `> a${eol}> =${eol}`).join(""),
  quotedNoSpace: (n, eol) => Array.from({ length: n }, () => `>a${eol}>===${eol}`).join(""),
  nestedQuote: (n, eol) => Array.from({ length: n }, () => `> > a${eol}> > ---${eol}`).join(""),
  listContained: (n, eol) => Array.from({ length: n }, () => `- a${eol}  =${eol}`).join(""),
  orderedContained: (n, eol) => Array.from({ length: n }, () => `1. a${eol}   ---${eol}`).join(""),
  quoteInList: (n, eol) => Array.from({ length: n }, () => `- > a${eol}  > =${eol}`).join(""),
  listInQuote: (n, eol) => Array.from({ length: n }, () => `> - a${eol}>   =${eol}`).join(""),
  bareDash: (n, eol) => Array.from({ length: n }, () => `a${eol}-${eol}`).join(""),
};

/** Mixed endings: the pairs cycle through LF, CRLF and CR. */
function mixedEndings(n: number, form: (n: number, eol: string) => string): string {
  const order = [LF, CRLF, CR];
  return Array.from({ length: n }, (_, i) => form(1, order[i % order.length]!)).join("");
}

const C1_REVIEW_QUOTED = `> a${LF}> =${LF}`.repeat(6000);
const C1_REVIEW_CR = `a${CR}=${CR}`.repeat(6000);
queue("c1-review-quoted", C1_REVIEW_QUOTED);
queue("c1-review-cr", C1_REVIEW_CR);
queue("c1-quoted-crlf", underlineForms.quoted!(MAX_MARKDOWN_SETEXT_UNDERLINES + 1, CRLF));

const ordinaryWithEndings: Record<string, string> = Object.fromEntries(
  Object.entries(LINE_ENDINGS).map(([name, eol]) => [
    name,
    [
      "Title",
      "=====",
      "",
      "> A quoted paragraph",
      "> that continues.",
      "",
      "> Quoted heading",
      "> ---",
      "",
      "- item one",
      "- item two",
      "",
      "```",
      "code ===",
      "```",
      "",
      `Unicode ${cp(0x6771, 0x4eac)}`,
    ].join(eol),
  ]),
);
for (const [name, source] of Object.entries(ordinaryWithEndings)) queue(`c1-ordinary-${name}`, source);

describe("review C1: underlines in containers and under every line ending", () => {
  for (const [formName, form] of Object.entries(underlineForms)) {
    for (const [eolName, eol] of Object.entries(LINE_ENDINGS)) {
      it(`${formName} with ${eolName}: ${MAX_MARKDOWN_SETEXT_UNDERLINES} allowed, ${MAX_MARKDOWN_SETEXT_UNDERLINES + 1} refused`, () => {
        assert.deepEqual(markdownComplexity(form(MAX_MARKDOWN_SETEXT_UNDERLINES, eol)), { ok: true });
        assert.deepEqual(markdownComplexity(form(MAX_MARKDOWN_SETEXT_UNDERLINES + 1, eol)), {
          ok: false,
          reason: "too-many-underlines",
        });
      });
    }
    it(`${formName} with mixed LF / CRLF / CR endings: boundary holds`, () => {
      assert.deepEqual(markdownComplexity(mixedEndings(MAX_MARKDOWN_SETEXT_UNDERLINES, form)), { ok: true });
      assert.deepEqual(markdownComplexity(mixedEndings(MAX_MARKDOWN_SETEXT_UNDERLINES + 1, form)), {
        ok: false,
        reason: "too-many-underlines",
      });
    });
  }

  it("CRLF is one line ending: it does not double-count list markers or lines", () => {
    const items = (n: number) => Array.from({ length: n }, () => `- a${CRLF}`).join("");
    assert.deepEqual(markdownComplexity(items(MAX_MARKDOWN_LIST_ITEMS)), { ok: true });
    assert.deepEqual(markdownComplexity(items(MAX_MARKDOWN_LIST_ITEMS + 1)), { ok: false, reason: "too-many-list-items" });
    // CR-only nesting is measured per CR-delimited line, too.
    assert.deepEqual(markdownComplexity(`${">".repeat(MAX_MARKDOWN_NESTING + 1)} x${CR}y`), { ok: false, reason: "too-deep" });
    assert.deepEqual(markdownComplexity(`${">".repeat(MAX_MARKDOWN_NESTING)} x${CR}${">".repeat(MAX_MARKDOWN_NESTING)} y`), { ok: true });
  });

  it("refuses both review payloads before any parse, in extraction, indexing and summaries", () => {
    for (const [name, source] of [
      ["quoted", C1_REVIEW_QUOTED],
      ["cr", C1_REVIEW_CR],
    ] as const) {
      assert.ok(source.length <= KNOWLEDGE_CONTENT_MAX, `${name} is a valid document size`);
      assert.deepEqual(markdownComplexity(source), { ok: false, reason: "too-many-underlines" }, name);
      const { result, parses } = countingParses(() => ({
        text: extractPlainText(source),
        key: buildKnowledgeSearchText({ title: "T", category: null, content: source }),
        summary: summarizeMarkdown(source),
        tree: parseKnowledgeMarkdown(source),
      }));
      assert.deepEqual(parses, [], `${name}: the parser was never invoked`);
      assert.equal(result.tree, null);
      assert.ok(result.summary.length <= 280);
      assert.ok(result.key.length > 0);
    }
  });

  it("renders refused documents as the escaped source, byte for byte, with nothing active", () => {
    const quoted = html("c1-review-quoted");
    assert.match(quoted, /data-markdown-mode="plain"/);
    assert.ok(quoted.includes(`<pre class="markdown-plain">${"&gt; a\n&gt; =\n".repeat(3)}`), "quoted source shown escaped and verbatim");
    assertInertMarkup(quoted, "c1 quoted");

    const cr = html("c1-review-cr");
    assert.match(cr, /data-markdown-mode="plain"/);
    // The CR characters survive into the fallback unchanged; nothing normalized them.
    assert.ok(cr.includes(`<pre class="markdown-plain">${`a${CR}=${CR}`.repeat(3)}`), "CR-only source shown verbatim");
    assertInertMarkup(cr, "c1 cr");

    assert.match(html("c1-quoted-crlf"), /data-markdown-mode="plain"/);
  });

  it("keeps ordinary headings, blockquotes, lists, code and Unicode formatted under every line ending", () => {
    for (const [name, source] of Object.entries(ordinaryWithEndings)) {
      assert.deepEqual(markdownComplexity(source), { ok: true }, name);
      const { result, parses } = countingParses(() => extractPlainText(source));
      assert.equal(parses.length, 1, `${name}: parsed once`);
      for (const expected of ["Title", "A quoted paragraph", "Quoted heading", "item one", "code ===", cp(0x6771, 0x4eac)]) {
        assert.ok(result.includes(expected), `${name}: missing ${JSON.stringify(expected)}`);
      }
      const out = html(`c1-ordinary-${name}`);
      assert.doesNotMatch(out, /data-markdown-mode="plain"/, name);
      assert.match(out, /<h2>Title<\/h2>/, name);
      assert.match(out, /<blockquote>[\s\S]*<h3>Quoted heading<\/h3>/, name);
      assert.match(out, /<li>item one<\/li>/, name);
      assertInertMarkup(out, `c1 ordinary ${name}`);
    }
  });
});

/*
 * Review finding C3: container prefixes inside indented nested-list content
 * (four or more spaces, or tabs) bypassed the depth, list and underline
 * budgets, because the pre-scan applied the root-level "at most three spaces"
 * rule to every line.
 */
const TAB = String.fromCharCode(9);

/**
 * A nested list whose innermost item's content is indented by `indent`, so a
 * line starting with `indent` continues that item — context-valid nesting.
 * `parents` is the number of list markers the prefix itself contains.
 */
function nestedContext(indent: "4" | "8" | "12" | "tab", eol: string): { prefix: string; ind: string; parents: number } {
  if (indent === "tab") {
    // "- outer" content starts at column 2; a tab (column 4) nests "- inner",
    // whose content starts at column 6; two tabs (column 8) continue it.
    return { prefix: `- outer${eol}${TAB}- inner${eol}`, ind: TAB + TAB, parents: 2 };
  }
  const levels = Number(indent) / 2; // each level's content is two columns deeper
  const prefix = Array.from({ length: levels }, (_, k) => `${" ".repeat(2 * k)}- level ${k + 1}${eol}`).join("");
  return { prefix, ind: " ".repeat(Number(indent)), parents: levels };
}

const INDENTS = ["4", "8", "12", "tab"] as const;
const C3_ENDINGS: Record<string, string> = { LF, CRLF, CR, mixed: "" };
/** Joins pieces with `eol`, or cycles LF / CRLF / CR when `eol` is "" (mixed). */
function joinEndings(pieces: string[], eol: string): string {
  const order = [LF, CRLF, CR];
  return pieces.map((p, i) => p + (eol === "" ? order[i % 3]! : eol)).join("");
}

function quotedHeadings(indent: (typeof INDENTS)[number], eol: string, n: number): string {
  const { prefix, ind } = nestedContext(indent, eol === "" ? LF : eol);
  return prefix + joinEndings(Array.from({ length: n }, () => [`${ind}>a`, `${ind}>=`]).flat(), eol);
}

/** Exactly `total` list markers in the document, parents included, two per line where possible. */
function nestedItems(indent: (typeof INDENTS)[number], eol: string, total: number): string {
  const { prefix, ind, parents } = nestedContext(indent, eol === "" ? LF : eol);
  const remaining = total - parents;
  const pieces = Array.from({ length: Math.floor(remaining / 2) }, () => `${ind}+ 1. a`);
  if (remaining % 2 === 1) pieces.push(`${ind}* a`);
  return prefix + joinEndings(pieces, eol);
}

function quoteDepth(indent: (typeof INDENTS)[number], eol: string, depth: number): string {
  const { prefix, ind } = nestedContext(indent, eol === "" ? LF : eol);
  return prefix + joinEndings([`${ind}${"> ".repeat(depth)}x`], eol);
}

const C3_PREFIX = `- outer${LF}  - inner${LF}`;
const C3_REVIEW: Record<string, { source: string; reason: string }> = {
  headings: { source: C3_PREFIX + `    >a${LF}    >=${LF}`.repeat(3500), reason: "too-many-underlines" },
  items: { source: C3_PREFIX + `    + a${LF}`.repeat(6000), reason: "too-many-list-items" },
  depth: { source: `${C3_PREFIX}    ${"> ".repeat(101)}x${LF}`, reason: "too-deep" },
};
for (const [name, { source }] of Object.entries(C3_REVIEW)) queue(`c3-review-${name}`, source);

/** Ordinary in-budget nested Markdown at each indentation. */
function ordinaryNested(indent: (typeof INDENTS)[number], eol: string): string {
  const { prefix, ind } = nestedContext(indent, eol);
  return (
    prefix +
    [
      `${ind}> Quoted heading`,
      `${ind}> ===`,
      `${ind}>`,
      `${ind}> - quoted item`,
      "",
      `${ind}1. first`,
      `${ind}2. second`,
      "",
      `${ind}Nested ${cp(0x6771, 0x4eac)} text`,
    ].join(eol) +
    eol
  );
}
for (const indent of INDENTS) queue(`c3-ordinary-${indent}`, ordinaryNested(indent, LF));

describe("review C3: container prefixes inside indented nested-list content", () => {
  it("refuses the three review payloads before any parse, and renders the escaped source", () => {
    for (const [name, { source, reason }] of Object.entries(C3_REVIEW)) {
      assert.ok(source.length <= KNOWLEDGE_CONTENT_MAX, `${name} is a valid document size`);
      assert.deepEqual(markdownComplexity(source), { ok: false, reason }, name);
      const { result, parses } = countingParses(() => ({
        text: extractPlainText(source),
        key: buildKnowledgeSearchText({ title: "T", category: null, content: source }),
        summary: summarizeMarkdown(source),
        tree: parseKnowledgeMarkdown(source),
      }));
      assert.deepEqual(parses, [], `${name}: the parser was never invoked`);
      assert.equal(result.tree, null);
      assert.equal(result.text, source.trim(), "plain text is the source, verbatim");
      const out = html(`c3-review-${name}`);
      assert.match(out, /data-markdown-mode="plain"/, name);
      assertInertMarkup(out, `c3 ${name}`);
    }
    assert.ok(html("c3-review-headings").includes(`<pre class="markdown-plain">- outer${LF}  - inner${LF}    &gt;a${LF}    &gt;=${LF}`));
    assert.equal(C3_REVIEW.headings!.source.length, 49_018);
    assert.equal(C3_REVIEW.items!.source.length, 48_018);
  });

  for (const indent of INDENTS) {
    for (const [endingName, eol] of Object.entries(C3_ENDINGS)) {
      const label = `${indent === "tab" ? "tab" : `${indent}-space`} content, ${endingName} endings`;

      it(`${label}: quoted headings — ${MAX_MARKDOWN_SETEXT_UNDERLINES} allowed, ${MAX_MARKDOWN_SETEXT_UNDERLINES + 1} refused`, () => {
        assert.deepEqual(markdownComplexity(quotedHeadings(indent, eol, MAX_MARKDOWN_SETEXT_UNDERLINES)), { ok: true });
        assert.deepEqual(markdownComplexity(quotedHeadings(indent, eol, MAX_MARKDOWN_SETEXT_UNDERLINES + 1)), {
          ok: false,
          reason: "too-many-underlines",
        });
      });

      it(`${label}: nested bullet and numbered items, parents counted — ${MAX_MARKDOWN_LIST_ITEMS} allowed, ${MAX_MARKDOWN_LIST_ITEMS + 1} refused`, () => {
        const atLimit = nestedItems(indent, eol, MAX_MARKDOWN_LIST_ITEMS);
        assert.ok(atLimit.length <= KNOWLEDGE_CONTENT_MAX, `fixture is ${atLimit.length} chars`);
        assert.deepEqual(markdownComplexity(atLimit), { ok: true });
        assert.deepEqual(markdownComplexity(nestedItems(indent, eol, MAX_MARKDOWN_LIST_ITEMS + 1)), {
          ok: false,
          reason: "too-many-list-items",
        });
      });

      it(`${label}: quote depth — ${MAX_MARKDOWN_NESTING} allowed, ${MAX_MARKDOWN_NESTING + 1} refused`, () => {
        assert.deepEqual(markdownComplexity(quoteDepth(indent, eol, MAX_MARKDOWN_NESTING)), { ok: true });
        assert.deepEqual(markdownComplexity(quoteDepth(indent, eol, MAX_MARKDOWN_NESTING + 1)), { ok: false, reason: "too-deep" });
      });
    }
  }

  it("counts every marker form after any whitespace, and stops at the first non-marker", () => {
    // Tabs and spaces mixed, markers interleaved: > - 1) > + 2. * — seven levels, five of them list items.
    const mixed = `${TAB}  > ${TAB}- 1)${TAB}>    + 2. * x`;
    assert.deepEqual(markdownComplexity(lines(...Array.from({ length: 800 }, () => mixed))), { ok: true });
    assert.deepEqual(markdownComplexity(lines(...Array.from({ length: 801 }, () => mixed))), {
      ok: false,
      reason: "too-many-list-items",
    });
    assert.deepEqual(markdownComplexity(lines(...Array.from({ length: 800 }, () => `${TAB}  > ${TAB}>x`))), { ok: true });
    // Not markers: a dash without a following space, a number without a delimiter or with a non-space after it.
    // Each line has three real markers (3,999 in all) and then the tail under
    // test; if the tail were miscounted as a marker, 1,333 more would exceed
    // the budget and the verdict would flip.
    for (const tail of ["-x", "2026-10-01", "1.5 million", "10)a", "+x", "*bold*", "1234567890. ten digits"]) {
      assert.deepEqual(
        markdownComplexity(lines(...Array.from({ length: 1_333 }, () => `    + + + ${tail}`))),
        { ok: true },
        `${JSON.stringify(tail)} must not count as a list marker`,
      );
    }
    assert.deepEqual(markdownComplexity(lines(...Array.from({ length: 1_334 }, () => "    + + + x"))), {
      ok: false,
      reason: "too-many-list-items",
    });
    // Nine digits are a marker.
    const nineDigits = (n: number) => lines(...Array.from({ length: n }, () => "  123456789) 1) 1) 1) a"));
    assert.deepEqual(markdownComplexity(nineDigits(MAX_MARKDOWN_LIST_ITEMS / 4)), { ok: true });
    assert.deepEqual(markdownComplexity(nineDigits(MAX_MARKDOWN_LIST_ITEMS / 4 + 1)), {
      ok: false,
      reason: "too-many-list-items",
    });
  });

  it("keeps the lone-dash rule after indentation: an indented bare `-` is an item and an underline", () => {
    const lone = (n: number) => lines(...Array.from({ length: n }, () => lines("    a", "    -")));
    assert.deepEqual(markdownComplexity(lone(MAX_MARKDOWN_SETEXT_UNDERLINES)), { ok: true });
    assert.deepEqual(markdownComplexity(lone(MAX_MARKDOWN_SETEXT_UNDERLINES + 1)), { ok: false, reason: "too-many-underlines" });
  });

  it("over-counts indented code on purpose: four-space `> ` and `- ` lines count like containers", () => {
    // In CommonMark these are code at the root; the context-free scan counts them anyway.
    const codeLooksLikeItems = (n: number) => lines(...Array.from({ length: n }, () => "    - - - - code"));
    assert.deepEqual(markdownComplexity(codeLooksLikeItems(MAX_MARKDOWN_LIST_ITEMS / 4)), { ok: true });
    assert.deepEqual(markdownComplexity(codeLooksLikeItems(MAX_MARKDOWN_LIST_ITEMS / 4 + 1)), {
      ok: false,
      reason: "too-many-list-items",
    });
    assert.deepEqual(markdownComplexity(`    ${"> ".repeat(MAX_MARKDOWN_NESTING + 1)}code`), { ok: false, reason: "too-deep" });
  });

  it("formats ordinary nested Markdown at every indentation, source unchanged", () => {
    for (const indent of INDENTS) {
      const source = ordinaryNested(indent, LF);
      const copy = source.slice();
      assert.deepEqual(markdownComplexity(source), { ok: true }, indent);
      const { result, parses } = countingParses(() => extractPlainText(source));
      assert.equal(parses.length, 1, `${indent}: parsed once`);
      for (const expected of ["Quoted heading", "quoted item", "first", "second", `Nested ${cp(0x6771, 0x4eac)} text`]) {
        assert.ok(result.includes(expected), `${indent}: missing ${JSON.stringify(expected)}`);
      }
      const out = html(`c3-ordinary-${indent}`);
      assert.doesNotMatch(out, /data-markdown-mode="plain"/, indent);
      assert.match(out, /<blockquote>[\s\S]*<h2>Quoted heading<\/h2>/, `${indent}: quoted heading inside the nested item`);
      assert.match(out, /<ol>[\s\S]*<li>first<\/li>/, `${indent}: numbered list inside the nested item`);
      assertInertMarkup(out, `c3 ordinary ${indent}`);
      assert.equal(source, copy, "the source string is never modified");
    }
  });
});

// Registered last so every source queued above (at module load) is in the batch.
before(() => {
  rendered = renderMarkdownBatch(toRender);
});

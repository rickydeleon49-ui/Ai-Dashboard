/**
 * Markdown workload diagnostics (Release 2E.1, review finding M1). Manual, not
 * part of any test suite, and never a pass/fail timing threshold:
 *
 *   npx tsx tests/diagnostics/markdown-workload.tsx
 *
 * Every case runs the real guarded paths — `extractPlainText` (search and
 * summaries) and a server render of `MarkdownView` (preview and reading) — in
 * its own child process with a hard timeout, so a slow case cannot stall the
 * run and a synchronous parse is genuinely bounded by the OS, not by a
 * promise. Numbers are machine-specific; the guard's decisions are not.
 */
import { spawnSync } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownView } from "../../src/components/knowledge/markdown-view";
import {
  KNOWLEDGE_CONTENT_MAX,
  MAX_MARKDOWN_CLOSING_BRACKETS,
  MAX_MARKDOWN_DELIMITERS,
  MAX_MARKDOWN_LIST_ITEMS,
  MAX_MARKDOWN_NESTING,
  MAX_MARKDOWN_SETEXT_UNDERLINES,
  extractPlainText,
  knowledgeMarkdownProcessor,
  markdownComplexity,
  summarizeMarkdown,
} from "../../src/core/knowledge/markdown";

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const C3_PREFIX = `- outer${NL}  - inner${NL}`;
/** A list nested `levels` deep, each level's content two columns further in. */
const nested = (levels: number) => Array.from({ length: levels }, (_, k) => `${" ".repeat(2 * k)}- level ${k + 1}${NL}`).join("");
const TIMEOUT_MS = 20_000;

/** Pads `head` with plain prose up to the content limit. */
function fill(head: string): string {
  let out = head;
  while (out.length < KNOWLEDGE_CONTENT_MAX - 40) out += `${NL}plain prose words here`;
  return out.slice(0, KNOWLEDGE_CONTENT_MAX);
}
const rep = (unit: string, max = KNOWLEDGE_CONTENT_MAX) => unit.repeat(Math.floor(max / unit.length));

/**
 * Deterministic pseudo-random documents from a Markdown-heavy alphabet. Tokens
 * that would push a counted construct past 90% of its budget are replaced by
 * plain text, so the guard admits the document and the parser does the work.
 */
function fuzz(seed: number): string {
  const alphabet = ["[", "]", "(", ")", "!", "<", ">", "`", "*", "_", "~", "#", "-", "=", "|", ":", "\\", "&", "a", " ", NL, "http://x.y", "[a](b)", "[^1]", `${NL}- `, `${NL}> `, `${NL}| a | b |`];
  let state = seed;
  let out = "";
  let brackets = 0;
  let delimiters = 0;
  let listItems = 0;
  while (out.length < KNOWLEDGE_CONTENT_MAX - 20) {
    state = (state * 1103515245 + 12345) % 2147483648;
    let token = alphabet[state % alphabet.length]!;
    const b = token.split("]").length - 1;
    const d = token.replace(/[^*_~]/g, "").length;
    const l = token === `${NL}- ` ? 1 : 0;
    if (brackets + b > MAX_MARKDOWN_CLOSING_BRACKETS * 0.9 || delimiters + d > MAX_MARKDOWN_DELIMITERS * 0.9 || listItems + l > MAX_MARKDOWN_LIST_ITEMS * 0.9) {
      token = "a";
    } else {
      brackets += b;
      delimiters += d;
      listItems += l;
    }
    out += token;
  }
  return out;
}

const cases: Record<string, () => string> = {
  // At the budgets — the most each construct may contribute.
  "brackets at budget": () => fill("]".repeat(MAX_MARKDOWN_CLOSING_BRACKETS)),
  "unclosed links at budget": () => fill("[a](".repeat(MAX_MARKDOWN_CLOSING_BRACKETS)),
  "shortcut refs at budget": () => fill("[a]".repeat(MAX_MARKDOWN_CLOSING_BRACKETS)),
  "definitions at budget": () => fill(`[a]: b${NL}`.repeat(MAX_MARKDOWN_CLOSING_BRACKETS)),
  "setext at budget": () => fill(`a${NL}===${NL}`.repeat(MAX_MARKDOWN_SETEXT_UNDERLINES)),
  // Review C1: the same headings inside containers and under CR / CRLF endings.
  "quoted setext at budget": () => fill(`> a${NL}> =${NL}`.repeat(MAX_MARKDOWN_SETEXT_UNDERLINES)),
  "list setext at budget": () => fill(`- a${NL}  =${NL}`.repeat(MAX_MARKDOWN_SETEXT_UNDERLINES)),
  "CR setext at budget": () => fill(`a${CR}=${CR}`.repeat(MAX_MARKDOWN_SETEXT_UNDERLINES)),
  "review C1 quoted (6,000)": () => `> a${NL}> =${NL}`.repeat(6000),
  "review C1 CR-only (6,000)": () => `a${CR}=${CR}`.repeat(6000),
  "review C1 CRLF (6,000)": () => `a${CR}${NL}=${CR}${NL}`.repeat(6000),
  // Review C3: container syntax inside indented nested-list content.
  "review C3 nested headings (3,500)": () => C3_PREFIX + `    >a${NL}    >=${NL}`.repeat(3500),
  "review C3 nested items (6,000)": () => C3_PREFIX + `    + a${NL}`.repeat(6000),
  "review C3 nested quote depth 101": () => `${C3_PREFIX}    ${"> ".repeat(101)}x${NL}`,
  "C3 4-space quoted setext at budget": () => fill(C3_PREFIX + `    >a${NL}    >=${NL}`.repeat(MAX_MARKDOWN_SETEXT_UNDERLINES)),
  "C3 8-space quoted setext at budget": () => fill(nested(4) + `        >a${NL}        >=${NL}`.repeat(MAX_MARKDOWN_SETEXT_UNDERLINES)),
  "C3 12-space quoted setext at budget": () => fill(nested(6) + `            >a${NL}            >=${NL}`.repeat(MAX_MARKDOWN_SETEXT_UNDERLINES)),
  "C3 tab quoted setext at budget": () => fill(`- outer${NL}${TAB}- inner${NL}` + `${TAB}${TAB}>a${NL}${TAB}${TAB}>=${NL}`.repeat(MAX_MARKDOWN_SETEXT_UNDERLINES)),
  "C3 4-space CR quoted setext at budget": () => fill(C3_PREFIX + `    >a${CR}    >=${CR}`.repeat(MAX_MARKDOWN_SETEXT_UNDERLINES)),
  "C3 nested items at budget": () => fill(C3_PREFIX + `    + 1. a${NL}`.repeat((MAX_MARKDOWN_LIST_ITEMS - 2) / 2)),
  "C3 nested quote depth at budget": () => fill(`${C3_PREFIX}    ${"> ".repeat(MAX_MARKDOWN_NESTING)}x${NL}`),
  "delimiters at budget": () => fill("*a".repeat(MAX_MARKDOWN_DELIMITERS)),
  "list items at budget": () => fill(`- a${NL}`.repeat(MAX_MARKDOWN_LIST_ITEMS)),
  "nesting at budget": () => fill(`${">".repeat(MAX_MARKDOWN_NESTING)} x${NL}`.repeat(50)),
  "all budgets combined": () =>
    fill(
      [
        "*a".repeat(MAX_MARKDOWN_DELIMITERS),
        "[a](".repeat(MAX_MARKDOWN_CLOSING_BRACKETS),
        `a${NL}===${NL}`.repeat(MAX_MARKDOWN_SETEXT_UNDERLINES),
        `${"- ".repeat(MAX_MARKDOWN_NESTING)}x`,
      ].join(NL),
    ),
  "links inside emphasis at budgets": () => fill("*[a](b)*".repeat(Math.min(MAX_MARKDOWN_CLOSING_BRACKETS, MAX_MARKDOWN_DELIMITERS / 2))),
  // Full-size candidates the counters do not limit.
  "open brackets": () => rep("["),
  "parentheses": () => rep("(()"),
  "angle brackets": () => rep("<a "),
  "autolinks": () => rep("<http://a.b> "),
  "www autolinks": () => rep("www.a.b "),
  "email autolinks": () => rep("a@b.c "),
  "backtick runs": () => rep("`a"),
  "entities": () => rep("&amp;"),
  "escapes": () => rep("\\["),
  "html comments": () => rep("<!--"),
  "table rows": () => rep(`|a|b|${NL}`),
  "tables": () => rep(`|a|b|${NL}|-|-|${NL}|1|2|${NL}${NL}`),
  "list items": () => rep(`- a${NL}`),
  "headings": () => rep(`# a${NL}`),
  "fences": () => rep(`\`\`\`${NL}`),
  "footnote refs": () => rep("[^"),
  "bang": () => rep("!["),
  // Deterministic fuzz; only documents the guard admits are parsed.
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`fuzz ${i + 1}`, () => fuzz(i + 1)])),
};

if (process.argv[2] === "--child") {
  const source = cases[process.argv[3]!]!();
  const verdict = markdownComplexity(source);
  const t0 = performance.now();
  extractPlainText(source);
  const t1 = performance.now();
  renderToStaticMarkup(<MarkdownView source={source} />);
  const t2 = performance.now();
  summarizeMarkdown(source);
  const t3 = performance.now();
  // Control for the C3 families only: the structure the real parser builds,
  // bypassing the guard. Diagnostic use only — production never parses to
  // decide whether to parse.
  let structure: string | undefined;
  if (process.argv[3]!.includes("C3")) {
    const tree = knowledgeMarkdownProcessor.parse(source);
    let headings = 0;
    let listItems = 0;
    let maxQuote = 0;
    const walk = (node: { type: string; children?: unknown[] }, quotes: number) => {
      const q = node.type === "blockquote" ? quotes + 1 : quotes;
      if (node.type === "heading") headings += 1;
      if (node.type === "listItem") listItems += 1;
      if (q > maxQuote) maxQuote = q;
      for (const child of node.children ?? []) walk(child as { type: string; children?: unknown[] }, q);
    };
    walk(tree as unknown as { type: string; children?: unknown[] }, 0);
    structure = `headings=${headings} items=${listItems} quoteDepth=${maxQuote}`;
  }
  process.stdout.write(
    JSON.stringify({
      length: source.length,
      guard: verdict.ok ? "parse" : `plain (${verdict.reason})`,
      extractMs: Math.round(t1 - t0),
      renderMs: Math.round(t2 - t1),
      summaryMs: Math.round(t3 - t2),
      structure,
    }),
  );
} else {
  console.log(`case | chars | guard | extract | render | summary | parsed structure (C3 controls)  (timeout ${TIMEOUT_MS / 1000}s per case)`);
  for (const name of Object.keys(cases)) {
    const run = spawnSync(process.execPath, [require.resolve("tsx/cli"), __filename, "--child", name], {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
    });
    if (run.error || run.signal) {
      console.log(`${name} | TIMEOUT`);
      continue;
    }
    if (run.status !== 0) {
      console.log(`${name} | ERROR ${run.stderr.split(NL).find((l) => l.trim()) ?? ""}`);
      continue;
    }
    const r = JSON.parse(run.stdout) as Record<string, string | number>;
    console.log(`${name} | ${r.length} | ${r.guard} | ${r.extractMs}ms | ${r.renderMs}ms | ${r.summaryMs}ms${r.structure ? ` | ${r.structure}` : ""}`);
  }
}

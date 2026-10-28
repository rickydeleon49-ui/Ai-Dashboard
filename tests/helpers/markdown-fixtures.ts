/**
 * Shared Release 2E.1 fixtures: stored-XSS payloads (unit render tests and the
 * browser suites seed the same corpus) and the search-parity corpus SQLite and
 * PostgreSQL must answer identically.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Server-renders many Markdown sources with `MarkdownView` in one child
 * process (see render-markdown-cli.tsx for why it cannot run in-process).
 */
export function renderMarkdownBatch(sources: Record<string, string>): Record<string, string> {
  const result = spawnSync(
    process.execPath,
    [require.resolve("tsx/cli"), path.join(__dirname, "render-markdown-cli.tsx")],
    { input: JSON.stringify(sources), encoding: "utf8", maxBuffer: 256 * 1024 * 1024, cwd: path.join(__dirname, "..", "..") },
  );
  if (result.status !== 0) {
    throw new Error(`render-markdown-cli failed (${result.status}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as Record<string, string>;
}

/**
 * Each value is stored as a document body exactly as written. None may ever
 * produce an element, attribute, URL or request beyond inert text.
 */
export const STORED_XSS_PAYLOADS: Record<string, string> = {
  scriptTag: "<script>window.__xss = 'script'</script>",
  scriptInParagraph: "before <script>window.__xss = 'inline'</script> after",
  imgOnerror: '<img src=x onerror="window.__xss = \'img\'">',
  svgOnload: '<svg onload="window.__xss = \'svg\'"><circle r="5"/></svg>',
  iframe: '<iframe src="https://evil.example/frame"></iframe>',
  iframeSrcdoc: '<iframe srcdoc="<script>parent.__xss=1</script>"></iframe>',
  objectEmbed: '<object data="https://evil.example/x.swf"></object><embed src="https://evil.example/e">',
  styleTag: "<style>body { background: url(https://evil.example/bg.png) }</style>",
  linkStylesheet: '<link rel="stylesheet" href="https://evil.example/s.css">',
  metaRefresh: '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  baseHref: '<base href="https://evil.example/">',
  formAction: '<form action="https://evil.example"><button>Go</button></form>',
  detailsOntoggle: '<details open ontoggle="window.__xss = \'details\'"><summary>x</summary></details>',
  anchorJavascript: '<a href="javascript:window.__xss=1">raw anchor</a>',
  mathXlink: '<math><mi xlink:href="javascript:window.__xss=1">x</mi></math>',
  videoPoster: '<video poster="https://evil.example/p.png" src="https://evil.example/v.mp4"></video>',
  markdownJavascriptLink: "[click me](javascript:window.__xss=1)",
  angleBracketJavascriptLink: "[click me](<javascript:window.__xss=1>)",
  entityEncodedJavascript: "[click me](jav&#x61;script:window.__xss=1)",
  numericEntityColon: "[click me](javascript&#58;window.__xss=1)",
  autolinkJavascript: "<javascript:window.__xss=1>",
  referenceJavascript: "[click me][r]\n\n[r]: javascript:window.__xss=1",
  dataUrlLink: "[open](data:text/html;base64,PHNjcmlwdD53aW5kb3cuX194c3M9MTwvc2NyaXB0Pg==)",
  vbscriptLink: "[open](vbscript:msgbox(1))",
  fileLink: "[open](file:///C:/Windows/System32/calc.exe)",
  protocolRelative: "[open](//evil.example/path)",
  credentialsLink: "[open](https://user:pass@evil.example/)",
  titleBreakout: '[ok](https://example.com "x\\" onmouseover=\\"window.__xss=1")',
  imageTracking: "![pixel](https://evil.example/track.png?doc=1)",
  imageJavascript: "![x](javascript:window.__xss=1)",
  imageDataUri: "![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)",
  htmlComment: "<!-- <script>window.__xss=1</script> -->visible",
  cdataAndPi: "<![CDATA[<script>window.__xss=1</script>]]><?php echo 1 ?>",
  nestedInList: "- item <img src=x onerror=window.__xss=1>\n- [x] <script>window.__xss=1</script>",
  inTable: "| a |\n|---|\n| <img src=x onerror=window.__xss=1> |",
  inCode: "```html\n<script>window.__xss = 'code'</script>\n```",
  footnoteJavascript: "Note[^x]\n\n[^x]: [bad](javascript:window.__xss=1)",
};

/** Tags no rendered document may ever contain as real elements. */
const FORBIDDEN_TAG =
  /<(script|img|iframe|frame|frameset|svg|math|object|embed|video|audio|source|track|picture|style|link|meta|base|form|button|textarea|select|details|summary|template|dialog|portal)\b/i;

/** Attributes a rendered document may carry. Everything else fails the check. */
const ALLOWED_ATTRIBUTES = new Set([
  "href",
  "title",
  "target",
  "rel",
  "referrerpolicy",
  "class",
  "id",
  "role",
  "aria-label",
  "tabindex",
  "type",
  "disabled",
  "readonly",
  "checked",
  "style",
  "start",
]);

/**
 * Asserts rendered markup contains no active content: no forbidden element,
 * only allowlisted attributes (so no event handler, `src`, `srcdoc`, `action`
 * or similar can appear), no inline style beyond table alignment, every `href`
 * within the link policy, and no form control except a disabled task-list
 * checkbox.
 *
 * React always double-quotes attribute values and escapes `"`, `<` and `>`
 * inside them, so tags and attributes can be tokenised exactly: text such as
 * `onmouseover=` inside a title's value is a value, not an attribute.
 */
export function assertInertMarkup(html: string, label: string): void {
  assert.doesNotMatch(html, FORBIDDEN_TAG, `${label}: forbidden element in ${html}`);
  const tags = html.match(/<[a-z][a-z0-9]*(?:\s[^>]*)?>/gi) ?? [];
  for (const tag of tags) {
    const name = /^<([a-z0-9]+)/i.exec(tag)![1]!.toLowerCase();
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(/\s([^\s="'>/]+)(?:="([^"]*)")?/g)) {
      attributes.set(match[1]!.toLowerCase(), match[2] ?? "");
    }
    for (const [attribute, value] of attributes) {
      if (attribute.startsWith("data-")) continue;
      assert.ok(ALLOWED_ATTRIBUTES.has(attribute), `${label}: attribute ${attribute} in ${tag}`);
      if (attribute === "style") assert.match(value, /^text-align:(left|right|center)$/, `${label}: style in ${tag}`);
      if (attribute === "href") assert.match(value, /^(https?:\/\/[^/]|\/(?!\/)|#)/, `${label}: unsafe href in ${tag}`);
    }
    if (name === "input") {
      assert.equal(attributes.get("type"), "checkbox", `${label}: ${tag}`);
      assert.ok(attributes.has("disabled"), `${label}: ${tag}`);
    }
  }
}

/** Documents for the search-parity checks; each backend stores all of them in one project. */
export const SEARCH_PARITY_DOCUMENTS: { title: string; category: string | null; content: string }[] = [
  { title: "Deploy runbook", category: "ops", content: "# Steps\n\nRun **release** then `npm run deploy`." },
  { title: "Links only", category: null, content: "See [the portal](https://portal-secret.example/x) for details." },
  { title: "Image doc", category: null, content: "![Network diagram](https://cdn.example/diagram.png)" },
  { title: "Raw HTML", category: null, content: "Text with <span class=\"hidden-markup\">inner words</span> inside." },
  { title: "Wildcards", category: "misc", content: "Coverage reached 100% for snake_case names." },
  { title: `Caf${String.fromCodePoint(0xe9)} notes`, category: "Fran\u00e7ais".normalize("NFC"), content: `Le CAF${String.fromCodePoint(0xc9)} est ouvert.` },
  { title: "Tasks", category: null, content: "- [x] Ship the build\n- [ ] Write the changelog" },
  { title: "Table", category: null, content: "| Owner | Area |\n|---|---|\n| Ana | Billing |" },
  { title: "Plain legacy", category: null, content: "plain text written before markdown existed" },
];

/** Query → titles that must match, in any order. */
export const SEARCH_PARITY_QUERIES: [string, string[]][] = [
  ["release", ["Deploy runbook"]],
  ["npm run deploy", ["Deploy runbook"]],
  ["**release**", []],
  ["the portal", ["Links only"]],
  ["portal-secret", []],
  ["network diagram", ["Image doc"]],
  ["cdn.example", []],
  ["inner words", ["Raw HTML"]],
  ["hidden-markup", []],
  ["<span", []],
  ["100%", ["Wildcards"]],
  ["snake_case", ["Wildcards"]],
  ["snakexcase", []],
  ["%", ["Wildcards"]],
  ["_", ["Wildcards"]],
  [`caf${String.fromCodePoint(0xe9)}`, [`Caf${String.fromCodePoint(0xe9)} notes`]],
  [`CAF${String.fromCodePoint(0xc9)} EST`, [`Caf${String.fromCodePoint(0xe9)} notes`]],
  ["ship the build", ["Tasks"]],
  ["ana billing", ["Table"]],
  ["ops", ["Deploy runbook"]],
  ["before markdown", ["Plain legacy"]],
  ["  RUNBOOK  ", ["Deploy runbook"]],
];

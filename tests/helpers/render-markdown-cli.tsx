/**
 * Renders `MarkdownView` to static markup for the unit tests.
 *
 * The unit suite runs under `--conditions=react-server`, where
 * `react-dom/server` deliberately refuses to load. This script runs in a child
 * process without that condition — the same React build a browser hydrates —
 * reading `{ key: source }` JSON on stdin and writing `{ key: html }` to stdout.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownView } from "../../src/components/knowledge/markdown-view";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const sources = JSON.parse(input) as Record<string, string>;
  const output: Record<string, string> = {};
  for (const [key, source] of Object.entries(sources)) {
    output[key] = renderToStaticMarkup(<MarkdownView source={source} />);
  }
  process.stdout.write(JSON.stringify(output));
});

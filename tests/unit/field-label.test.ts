import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

const html = JSON.parse(
  execFileSync(process.execPath, ["--import", "tsx", "tests/helpers/render-field-cli.tsx"], {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  }),
) as Record<string, string>;

describe("Field label association", () => {
  it("links the label to a single control and describes it with help text", () => {
    const out = html.select!;
    const forId = /<label for="([^"]+)"/.exec(out)?.[1];
    assert.ok(forId);
    assert.ok(out.includes(`id="${forId}"`));
    assert.match(out, new RegExp(`<select[^>]*id="${forId}"`));
    const noteId = /<p id="([^"]+)"/.exec(out)?.[1];
    assert.ok(noteId);
    assert.ok(out.includes(`aria-describedby="${noteId}"`));
  });

  it("keeps an existing id", () => {
    assert.ok(html.ownId!.includes('<label for="mine"'));
  });

  it("wraps multiple children in a labelled group", () => {
    assert.ok(html.group!.includes('role="group" aria-labelledby='));
    assert.ok(!html.group!.includes("<label"));
  });
});

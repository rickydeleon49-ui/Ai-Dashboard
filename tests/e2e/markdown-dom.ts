/**
 * Browser-side checks for rendered knowledge Markdown (Release 2E.1), shared by
 * the web, accounts-mode and desktop suites so all three assert the same thing:
 * the rendered DOM — not markup strings — has no active content, nothing
 * executed, no dialog opened and no request left the app's origin.
 */
import assert from "node:assert/strict";
import type { Page } from "playwright";

/**
 * Watches a page for anything a document could make happen: dialogs, script
 * side effects and requests to any origin other than the app's own.
 */
export function watch(page: Page, appOrigin: string) {
  const dialogs: string[] = [];
  const foreignRequests: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) {
      foreignRequests.push(url.slice(0, 80));
      return;
    }
    if (new URL(url).origin !== appOrigin) foreignRequests.push(url);
  });
  return { dialogs, foreignRequests };
}

/** The rendered document's DOM, inspected in the page — elements, attributes and links. */
export async function inspectRendered(page: Page) {
  return page.evaluate(() => {
    const roots = Array.from(document.querySelectorAll("[data-markdown-view]"));
    const forbidden = roots.flatMap((root) =>
      Array.from(
        root.querySelectorAll(
          "script,img,picture,iframe,frame,svg,math,object,embed,video,audio,source,style,link,meta,base,form,button,textarea,select,details,template,dialog",
        ),
      ).map((el) => el.outerHTML.slice(0, 120)),
    );
    const eventAttributes: string[] = [];
    const urlAttributes: string[] = [];
    for (const root of roots) {
      for (const el of Array.from(root.querySelectorAll("*"))) {
        for (const attr of Array.from(el.attributes)) {
          if (attr.name.toLowerCase().startsWith("on")) eventAttributes.push(`${el.tagName}[${attr.name}]`);
          if (["src", "srcdoc", "srcset", "action", "formaction", "poster", "background", "xlink:href", "data"].includes(attr.name.toLowerCase())) {
            urlAttributes.push(`${el.tagName}[${attr.name}]`);
          }
        }
      }
    }
    const links = roots.flatMap((root) =>
      Array.from(root.querySelectorAll("a")).map((a) => ({
        href: a.getAttribute("href"),
        protocol: a.href ? new URL(a.href).protocol : null,
        target: a.getAttribute("target"),
        rel: a.getAttribute("rel"),
        text: a.textContent,
      })),
    );
    const inputs = roots.flatMap((root) =>
      Array.from(root.querySelectorAll("input")).map((input) => ({ type: input.type, disabled: input.disabled })),
    );
    return {
      roots: roots.length,
      forbidden,
      eventAttributes,
      urlAttributes,
      links,
      inputs,
      xss: (window as unknown as { __xss?: unknown }).__xss ?? null,
    };
  });
}

export function assertInertDom(result: Awaited<ReturnType<typeof inspectRendered>>, label: string) {
  assert.ok(result.roots > 0, `${label}: nothing rendered`);
  assert.deepEqual(result.forbidden, [], `${label}: forbidden elements`);
  assert.deepEqual(result.eventAttributes, [], `${label}: event-handler attributes`);
  assert.deepEqual(result.urlAttributes, [], `${label}: URL attributes`);
  assert.equal(result.xss, null, `${label}: a payload executed`);
  for (const link of result.links) {
    assert.ok(link.protocol === "http:" || link.protocol === "https:", `${label}: link ${JSON.stringify(link)}`);
    assert.match(link.href ?? "", /^(https?:\/\/[^/]|\/(?!\/)|#)/, `${label}: link ${JSON.stringify(link)}`);
  }
  for (const input of result.inputs) {
    assert.deepEqual(input, { type: "checkbox", disabled: true }, `${label}: input`);
  }
}

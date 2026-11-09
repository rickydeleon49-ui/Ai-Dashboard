/**
 * The one renderer for knowledge-document Markdown: the editor's Preview tab,
 * the document page and the expanded list card all use it, so what a writer
 * previews is exactly what readers see.
 *
 * Safety comes from construction, not from cleaning HTML afterwards:
 *   - react-markdown turns the Markdown tree into React elements directly.
 *     There is no HTML string and no `dangerouslySetInnerHTML` anywhere.
 *   - Raw HTML in a document is shown as literal text (react-markdown's
 *     default with `skipHtml` off), so `<script>` or `onerror=` never becomes
 *     an element or an attribute.
 *   - `allowedElements` is an explicit list; anything else the tree could
 *     contain is unwrapped to its text.
 *   - Every URL goes through `resolveMarkdownLink`; refused links lose their
 *     destination and keep their text.
 *   - Images never load. They render as their alt text, so a document cannot
 *     make a reader's browser contact a third party.
 *   - The remark plugins and components are fixed in code; content cannot
 *     choose a plugin, component or element.
 *
 * Not a Client Component: it has no state, so a Server Component renders it
 * without shipping it, and the client editor includes it in its own bundle.
 */
import type { ComponentProps, ReactElement, ReactNode } from "react";
import Markdown, { type AllowElement, type Components, type UrlTransform } from "react-markdown";
import { knowledgeRemarkPlugins, markdownComplexity } from "@/core/knowledge/markdown";
import { resolveMarkdownLink } from "@/core/knowledge/markdown-links";
import { cn } from "@/lib/utils";

/** Every element the renderer may produce. Footnotes need `section` and `sup`. */
const ALLOWED_ELEMENTS = [
  "p",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "ul",
  "ol",
  "li",
  "input",
  "pre",
  "code",
  "em",
  "strong",
  "del",
  "a",
  "img",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "section",
  "sup",
];

/** The only `input` GFM produces is a task-list checkbox; nothing else gets through. */
const allowElement: AllowElement = (element) =>
  element.tagName !== "input" || element.properties?.type === "checkbox";

/** Links pass the policy or become empty; image sources are always dropped. */
const urlTransform: UrlTransform = (url, key, node) => {
  if (node.tagName === "img" || key === "src") return "";
  if (key !== "href") return "";
  return resolveMarkdownLink(url)?.href ?? "";
};

type WithNode<T> = T & { node?: unknown };

function SafeLink({ href, children, title }: WithNode<ComponentProps<"a">>): ReactElement {
  const link = resolveMarkdownLink(href);
  if (!link) {
    return (
      <span className="markdown-unsafe-link" data-markdown-link="refused" title="Link removed: unsupported address">
        {children}
      </span>
    );
  }
  if (link.kind === "external") {
    // A new window is what the desktop shell intercepts and hands to the
    // user's browser (`setWindowOpenHandler` in desktop/main.js). On the web,
    // `noopener noreferrer` stops the new page reaching back into this one or
    // learning which document linked to it.
    return (
      <a
        href={link.href}
        title={title}
        target="_blank"
        rel="noopener noreferrer nofollow ugc"
        referrerPolicy="no-referrer"
        data-markdown-link="external"
      >
        {children}
      </a>
    );
  }
  return (
    <a href={link.href} title={title} data-markdown-link={link.kind}>
      {children}
    </a>
  );
}

function ImagePlaceholder({ alt }: WithNode<ComponentProps<"img">>): ReactElement {
  const label = typeof alt === "string" && alt.trim() ? alt.trim() : "image";
  return (
    <span className="markdown-image" data-markdown-image="blocked" role="img" aria-label={`Image not loaded: ${label}`}>
      [Image: {label}]
    </span>
  );
}

function TaskCheckbox({ checked }: WithNode<ComponentProps<"input">>): ReactElement {
  return (
    <input
      type="checkbox"
      checked={Boolean(checked)}
      disabled
      readOnly
      aria-label={checked ? "Completed" : "Not completed"}
    />
  );
}

/**
 * Markdown headings start one level down: the page already has its own `h1`
 * (the document title), and a document should not compete with it.
 */
function heading(level: 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${level}` as const;
  return function Heading({ children, id }: WithNode<ComponentProps<"h1">>): ReactElement {
    return <Tag id={id}>{children}</Tag>;
  };
}

const components: Components = {
  a: SafeLink,
  img: ImagePlaceholder,
  input: TaskCheckbox,
  h1: heading(2),
  h2: heading(3),
  h3: heading(4),
  h4: heading(5),
  h5: heading(6),
  h6: heading(6),
  table: ({ children }: WithNode<ComponentProps<"table">>) => (
    <div className="markdown-table" role="region" aria-label="Table" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
  pre: ({ children }: WithNode<ComponentProps<"pre">>) => <pre tabIndex={0}>{children}</pre>,
};

/** How a document the complexity guard refuses is shown: its own text, verbatim. */
function PlainTextFallback({ source }: { source: string }): ReactElement {
  return (
    <div data-markdown-mode="plain">
      <p className="markdown-notice">Shown as plain text — this document is too complex to format.</p>
      <pre className="markdown-plain">{source}</pre>
    </div>
  );
}

export function MarkdownView({
  source,
  className,
  empty,
}: {
  source: string;
  className?: string;
  /** Shown when the document has no content. */
  empty?: ReactNode;
}): ReactElement {
  if (source.trim().length === 0) {
    return <div className={cn("markdown-body min-w-0", className)}>{empty ?? <p className="text-faint">No content yet.</p>}</div>;
  }

  let rendered: ReactElement;
  if (!markdownComplexity(source).ok) {
    rendered = <PlainTextFallback source={source} />;
  } else {
    try {
      // Called directly rather than as <Markdown />: react-markdown's sync
      // component builds its tree immediately, so a parser failure surfaces
      // here, where it can fall back, instead of breaking the whole page.
      rendered = Markdown({
        children: source,
        remarkPlugins: knowledgeRemarkPlugins,
        allowedElements: ALLOWED_ELEMENTS,
        allowElement,
        unwrapDisallowed: true,
        skipHtml: false,
        urlTransform,
        components,
      });
    } catch {
      rendered = <PlainTextFallback source={source} />;
    }
  }

  return (
    <div className={cn("markdown-body min-w-0", className)} data-markdown-view="">
      {rendered}
    </div>
  );
}

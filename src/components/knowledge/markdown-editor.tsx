"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Textarea } from "@/components/ui/field";
import { MarkdownView } from "@/components/knowledge/markdown-view";
import { KNOWLEDGE_CONTENT_MAX } from "@/core/knowledge/markdown";
import { cn } from "@/lib/utils";

type Mode = "write" | "preview";

/**
 * Write/Preview editing for a knowledge document's Markdown.
 *
 * - The textarea stays mounted (hidden in Preview), so switching tabs never
 *   loses unsaved text and the form still submits it.
 * - Preview uses the same `MarkdownView` readers see; it only renders while
 *   the Preview tab is open, so typing never pays for rendering.
 * - The tabs follow the WAI-ARIA tabs pattern: arrow keys, Home and End move
 *   between them, and only the selected tab is in the Tab order.
 */
export function MarkdownEditor({
  name,
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  const textareaId = `${id}-textarea`;
  const countId = `${id}-count`;
  const [mode, setMode] = useState<Mode>("write");
  const tabs = useRef<Record<Mode, HTMLButtonElement | null>>({ write: null, preview: null });

  const over = value.length > KNOWLEDGE_CONTENT_MAX;

  function select(next: Mode, focus: boolean) {
    setMode(next);
    if (focus) tabs.current[next]?.focus();
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const order: Mode[] = ["write", "preview"];
    const index = order.indexOf(mode);
    let next: Mode | null = null;
    if (event.key === "ArrowRight") next = order[(index + 1) % order.length]!;
    else if (event.key === "ArrowLeft") next = order[(index + order.length - 1) % order.length]!;
    else if (event.key === "Home") next = order[0]!;
    else if (event.key === "End") next = order[order.length - 1]!;
    if (next) {
      event.preventDefault();
      select(next, true);
    }
  }

  const tab = (value: Mode, text: string) => (
    <button
      ref={(element) => {
        tabs.current[value] = element;
      }}
      type="button"
      role="tab"
      id={`${id}-tab-${value}`}
      aria-selected={mode === value}
      aria-controls={`${id}-panel-${value}`}
      tabIndex={mode === value ? 0 : -1}
      onClick={() => select(value, false)}
      onKeyDown={onTabKeyDown}
      className={cn(
        "rounded px-2.5 py-1 text-[12px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        mode === value ? "bg-[var(--bg-hover)] text-fg" : "text-faint hover:text-muted",
      )}
    >
      {text}
    </button>
  );

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <label htmlFor={textareaId} className="text-[12px] font-medium text-muted">
          {label}
        </label>
        <div role="tablist" aria-label={`${label} view`} className="flex items-center gap-0.5 rounded-md border border-line p-0.5">
          {tab("write", "Write")}
          {tab("preview", "Preview")}
        </div>
      </div>

      <div
        role="tabpanel"
        id={`${id}-panel-write`}
        aria-labelledby={`${id}-tab-write`}
        hidden={mode !== "write"}
      >
        <Textarea
          id={textareaId}
          name={name}
          rows={16}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          aria-describedby={countId}
          aria-invalid={over || undefined}
          spellCheck
          className="font-mono text-[12.5px] leading-relaxed"
        />
      </div>

      <div
        role="tabpanel"
        id={`${id}-panel-preview`}
        aria-labelledby={`${id}-tab-preview`}
        hidden={mode !== "preview"}
        tabIndex={0}
        className="min-h-40 rounded-md border border-line bg-[var(--bg-subtle)] px-3.5 py-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        {mode === "preview" ? (
          <MarkdownView source={value} empty={<p className="text-faint">Nothing to preview yet.</p>} />
        ) : null}
      </div>

      <p id={countId} className={cn("flex flex-wrap justify-between gap-2 text-[11px]", over ? "text-red-400" : "text-faint")}>
        <span>Markdown: headings, lists, tables, links, code and task lists. HTML is shown as text.</span>
        <span className="tabular-nums">
          {value.length.toLocaleString("en-US")} / {KNOWLEDGE_CONTENT_MAX.toLocaleString("en-US")}
          {over ? " — too long to save" : ""}
        </span>
      </p>
    </div>
  );
}

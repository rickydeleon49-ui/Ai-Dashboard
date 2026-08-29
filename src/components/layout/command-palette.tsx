"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, CornerDownLeft, Search } from "lucide-react";
import { NAVIGATION } from "@/config/navigation";
import { QUICK_ACTIONS } from "@/config/quick-actions";
import { cn } from "@/lib/utils";

export interface PaletteProject {
  id: string;
  name: string;
  source: string;
  status: string;
}

interface Command {
  id: string;
  label: string;
  hint: string;
  group: string;
  href: string;
}

/**
 * Cmd/Ctrl+K launcher over navigation, quick actions and every project.
 *
 * The project list is passed in from the server layout — small enough to filter
 * client-side, which keeps the palette instant.
 */
export function CommandPalette({ projects }: { projects: PaletteProject[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = NAVIGATION.flatMap((group) =>
      group.items.map((item) => ({
        id: `nav:${item.href}`,
        label: item.label,
        hint: group.label,
        group: "Navigate",
        href: item.href,
      })),
    );

    const actions: Command[] = QUICK_ACTIONS.map((action) => ({
      id: `action:${action.href}:${action.label}`,
      label: action.label,
      hint: action.description,
      group: "Actions",
      href: action.href,
    }));

    const projectCommands: Command[] = projects.map((project) => ({
      id: `project:${project.id}`,
      label: project.name,
      hint: `${project.source} · ${project.status}`,
      group: "Projects",
      href: `/projects/${project.id}`,
    }));

    return [...actions, ...projectCommands, ...nav];
  }, [projects]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? commands.filter(
          (c) =>
            c.label.toLowerCase().includes(needle) ||
            c.hint.toLowerCase().includes(needle),
        )
      : commands;
    return matches.slice(0, 40);
  }, [commands, query]);

  // Opening resets the palette here rather than in an effect, so there is no
  // cascading render between "open" and "cleared".
  const openPalette = useCallback(() => {
    setQuery("");
    setIndex(0);
    setOpen(true);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((wasOpen) => {
          if (!wasOpen) {
            setQuery("");
            setIndex(0);
          }
          return !wasOpen;
        });
      }
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Focus the input once the dialog has painted.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  /** Typing always restarts the selection at the first result. */
  function updateQuery(value: string) {
    setQuery(value);
    setIndex(0);
  }

  // Keep the highlighted row inside the scroll viewport.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${index}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [index]);

  function run(command: Command | undefined) {
    if (!command) return;
    setOpen(false);
    router.push(command.href);
  }

  function onInputKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((i) => (i + 1) % Math.max(results.length, 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((i) => (i - 1 + results.length) % Math.max(results.length, 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(results[index]);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={openPalette}
        className={cn(
          "group flex h-8 w-full max-w-72 items-center gap-2 rounded-md border border-line",
          "bg-[var(--bg-subtle)] px-2.5 text-[13px] text-faint transition-colors",
          "hover:border-[var(--border-strong)] hover:text-muted",
        )}
      >
        <Search className="h-3.5 w-3.5" strokeWidth={1.75} />
        <span className="flex-1 text-left">Search projects…</span>
        <kbd className="rounded border border-line bg-[var(--bg-elevated)] px-1 py-px font-sans text-[10px] text-faint">
          ⌘K
        </kbd>
      </button>
    );
  }

  let lastGroup = "";

  return (
    <>
      <button
        type="button"
        onClick={openPalette}
        className="flex h-8 w-full max-w-72 items-center gap-2 rounded-md border border-line bg-[var(--bg-subtle)] px-2.5 text-[13px] text-faint"
      >
        <Search className="h-3.5 w-3.5" strokeWidth={1.75} />
        <span className="flex-1 text-left">Search projects…</span>
      </button>

      <div
        className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh] backdrop-blur-sm animate-fade-in"
        onClick={() => setOpen(false)}
        role="presentation"
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-xl overflow-hidden rounded-xl border border-[var(--border-strong)] bg-surface shadow-2xl animate-scale-in"
        >
          <div className="flex items-center gap-2.5 border-b border-line px-3.5">
            <Search className="h-4 w-4 shrink-0 text-faint" strokeWidth={1.75} />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => updateQuery(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="Search projects, actions and pages…"
              className="h-11 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-faint"
            />
            <kbd className="rounded border border-line px-1 py-px font-sans text-[10px] text-faint">
              ESC
            </kbd>
          </div>

          <div ref={listRef} className="max-h-80 overflow-y-auto p-1.5">
            {results.length === 0 ? (
              <p className="px-3 py-8 text-center text-[13px] text-faint">
                No matches for “{query}”
              </p>
            ) : (
              results.map((command, i) => {
                const showGroup = command.group !== lastGroup;
                lastGroup = command.group;
                return (
                  <div key={command.id}>
                    {showGroup ? (
                      <p className="px-2.5 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">
                        {command.group}
                      </p>
                    ) : null}
                    <button
                      type="button"
                      data-index={i}
                      onMouseEnter={() => setIndex(i)}
                      onClick={() => run(command)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors",
                        i === index ? "bg-[var(--bg-hover)]" : "hover:bg-[var(--bg-subtle)]",
                      )}
                    >
                      <ArrowRight
                        className="h-3.5 w-3.5 shrink-0 text-faint"
                        strokeWidth={1.75}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-fg">
                          {command.label}
                        </span>
                        <span className="block truncate text-[11px] text-faint">
                          {command.hint}
                        </span>
                      </span>
                      {i === index ? (
                        <CornerDownLeft
                          className="h-3.5 w-3.5 shrink-0 text-faint"
                          strokeWidth={1.75}
                        />
                      ) : null}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </>
  );
}

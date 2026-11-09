"use client";

import { useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { Select } from "@/components/ui/field";
import { PROJECT_SORTS, PROJECT_SOURCES, PROJECT_STATUSES } from "@/core/projects/types";
import { SOURCE_META, STATUS_META } from "@/core/projects/labels";
import type { TagCount } from "@/db/repositories/project-repository";
import { cn } from "@/lib/utils";

const SORT_LABELS: Record<string, string> = {
  updated: "Last updated",
  created: "Date created",
  opened: "Recently opened",
  name: "Name",
  status: "Status",
};

/**
 * Search and filter controls for the project library.
 *
 * All state lives in the URL, so a filtered view is shareable, bookmarkable and
 * survives a refresh — and the server component re-queries on every change.
 */
export function ProjectFilters({
  tags,
  lockedSource,
}: {
  tags: TagCount[];
  /** Set on the GitHub/Uploads pages, where the source filter is fixed. */
  lockedSource?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const urlSearch = params.get("search") ?? "";
  const [search, setSearch] = useState(urlSearch);
  const [syncedSearch, setSyncedSearch] = useState(urlSearch);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the input in step when the URL changes from elsewhere (a Clear press,
  // the back button, a shared link). Adjusting during render is React's
  // supported pattern for this and avoids the extra pass an effect would cost.
  if (urlSearch !== syncedSearch) {
    setSyncedSearch(urlSearch);
    setSearch(urlSearch);
  }

  function push(next: URLSearchParams) {
    const qs = next.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (!value || value === "all") next.delete(key);
    else next.set(key, value);
    push(next);
  }

  function onSearchChange(value: string) {
    setSearch(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setParam("search", value.trim()), 220);
  }

  const activeCount = ["search", "source", "status", "tag", "sort", "archived"].filter(
    (key) => params.get(key),
  ).length;

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <div className="relative min-w-0 w-full sm:w-auto sm:min-w-52 sm:flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint"
            strokeWidth={1.75}
          />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search names, descriptions, notes and tags…"
            aria-label="Search projects"
            className={cn(
              "h-8 min-h-[40px] md:min-h-0 w-full rounded-md border border-line bg-[var(--bg-subtle)] pl-8 pr-8 text-[13px]",
              "text-fg placeholder:text-faint transition-colors",
              "hover:border-[var(--border-strong)] focus:border-[var(--accent)] focus:outline-none",
              "focus:ring-2 focus:ring-[var(--accent-soft)]",
            )}
          />
          {search ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => onSearchChange("")}
              className="absolute right-1 top-1/2 -translate-y-1/2 flex h-8 w-8 min-h-[40px] min-w-[40px] md:min-h-0 md:min-w-0 md:h-8 md:w-8 items-center justify-center text-faint hover:text-muted"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          ) : null}
        </div>

        {!lockedSource ? (
          <Select
            aria-label="Filter by source"
            value={params.get("source") ?? "all"}
            onChange={(e) => setParam("source", e.target.value)}
            className="w-auto min-w-28 min-h-[40px] md:min-h-0"
          >
            <option value="all">All sources</option>
            {PROJECT_SOURCES.map((source) => (
              <option key={source} value={source}>
                {SOURCE_META[source].label}
              </option>
            ))}
          </Select>
        ) : null}

        <Select
          aria-label="Filter by status"
          value={params.get("status") ?? "all"}
          onChange={(e) => setParam("status", e.target.value)}
          className="w-auto min-w-28 min-h-[40px] md:min-h-0"
        >
          <option value="all">All statuses</option>
          {PROJECT_STATUSES.filter((s) => s !== "archived").map((status) => (
            <option key={status} value={status}>
              {STATUS_META[status].label}
            </option>
          ))}
        </Select>

        <Select
          aria-label="Sort projects"
          value={params.get("sort") ?? "updated"}
          onChange={(e) => setParam("sort", e.target.value)}
          className="w-auto min-w-32 min-h-[40px] md:min-h-0"
        >
          {PROJECT_SORTS.map((sort) => (
            <option key={sort} value={sort}>
              {SORT_LABELS[sort]}
            </option>
          ))}
        </Select>

        <label className="flex h-8 min-h-[40px] md:min-h-0 cursor-pointer select-none items-center gap-1.5 rounded-md border border-line bg-[var(--bg-subtle)] px-2.5 text-[12.5px] text-muted transition-colors hover:border-[var(--border-strong)]">
          <input
            type="checkbox"
            checked={params.get("archived") === "1"}
            onChange={(e) => setParam("archived", e.target.checked ? "1" : "")}
            className="h-3.5 w-3.5 accent-[var(--accent)]"
          />
          Archived
        </label>

        {activeCount > 0 ? (
          <button
            type="button"
            onClick={() => push(new URLSearchParams())}
            className="flex h-8 min-h-[40px] md:min-h-0 items-center rounded-md px-2 text-[12.5px] text-faint transition-colors hover:text-fg"
          >
            Clear
          </button>
        ) : null}
      </div>

      {tags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          {tags.slice(0, 16).map((tag) => {
            const active = params.get("tag") === tag.name;
            return (
              <button
                key={tag.name}
                type="button"
                onClick={() => setParam("tag", active ? "" : tag.name)}
                className={cn(
                  "inline-flex items-center rounded px-2 py-1 text-[11px] font-medium ring-1 ring-inset transition-colors min-h-[40px] md:min-h-0",
                  active
                    ? "bg-[var(--accent-soft)] text-[var(--accent-text)] ring-[var(--accent)]/40"
                    : "bg-[var(--bg-subtle)] text-muted ring-[var(--border)] hover:text-fg",
                )}
              >
                <span className="break-words">{tag.name}</span>
                <span className="ml-1 tabular-nums text-faint">{tag.count}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

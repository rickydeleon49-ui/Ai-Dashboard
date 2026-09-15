"use client";

import { useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Search and category filters for a project's knowledge base — mirrors
 * `components/prompts/prompt-filters.tsx`'s own URL-driven pattern (a
 * filtered view is shareable and survives a refresh; the server re-queries
 * rather than filtering in memory).
 */
export function KnowledgeDocumentFilters({
  categories,
}: {
  categories: { name: string; count: number }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const urlSearch = params.get("search") ?? "";
  const [search, setSearch] = useState(urlSearch);
  const [synced, setSynced] = useState(urlSearch);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Adjusting during render is React's supported pattern for reacting to a
  // prop-like change, and avoids the extra pass an effect would cost.
  if (urlSearch !== synced) {
    setSynced(urlSearch);
    setSearch(urlSearch);
  }

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (!value) next.delete(key);
    else next.set(key, value);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  function onSearch(value: string) {
    setSearch(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setParam("search", value.trim()), 220);
  }

  const activeCategory = params.get("category") ?? "";

  return (
    <div className="space-y-3">
      <div className="relative min-w-52 max-w-md">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint"
          strokeWidth={1.75}
        />
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search titles and content…"
          aria-label="Search knowledge base"
          className="h-8 w-full rounded-md border border-line bg-[var(--bg-subtle)] pl-8 pr-8 text-[13px] text-fg placeholder:text-faint hover:border-[var(--border-strong)] focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-soft)]"
        />
        {search ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onSearch("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-muted"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        ) : null}
      </div>

      {categories.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {categories.map((category) => {
            const active = activeCategory === category.name;
            return (
              <button
                key={category.name}
                type="button"
                onClick={() => setParam("category", active ? "" : category.name)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset transition-colors",
                  active
                    ? "bg-[var(--accent-soft)] text-[var(--accent-text)] ring-[var(--accent)]/40"
                    : "bg-[var(--bg-subtle)] text-muted ring-[var(--border)] hover:text-fg",
                )}
              >
                {category.name}
                <span className="ml-1 tabular-nums text-faint">{category.count}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Check,
  CircleDot,
  ExternalLink,
  GitFork,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Star as StarIcon,
} from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { languageColor } from "@/core/projects/labels";
import { githubLinks } from "@/core/github/types";
import type { HubRepository } from "@/core/github/service";
import { cn, formatCompact, formatRelative } from "@/lib/utils";

/** Triggers a sync against the active provider and refreshes the page data. */
export function SyncButton({ mode }: { mode: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function sync() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/github/sync", { method: "POST" });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Sync failed");
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="primary" onClick={sync} disabled={busy}>
        <RefreshCw
          className={cn("h-3.5 w-3.5", busy && "animate-spin")}
          strokeWidth={1.75}
        />
        {busy ? "Syncing…" : "Sync repositories"}
      </Button>
      {error ? (
        <p className="max-w-64 text-right text-[11px] text-red-400">{error}</p>
      ) : null}
      {!error && mode === "demo" ? (
        <p className="text-[11px] text-faint">Syncs demo data</p>
      ) : null}
    </div>
  );
}

/** Adds a synced repository to the dashboard as a project. */
function AddButton({ repo }: { repo: HubRepository }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    await fetch("/api/github/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalId: repo.externalId }),
    });
    setBusy(false);
    router.refresh();
  }

  if (repo.linkedProjectId) {
    return (
      <Link
        href={`/projects/${repo.linkedProjectId}`}
        className={buttonClasses("secondary", "sm")}
      >
        <Check className="h-3 w-3 text-emerald-400" strokeWidth={2.25} />
        On dashboard
        <ArrowRight className="h-3 w-3" strokeWidth={1.75} />
      </Link>
    );
  }

  return (
    <Button size="sm" onClick={add} disabled={busy}>
      <Plus className="h-3 w-3" strokeWidth={2.25} />
      {busy ? "Adding…" : "Add"}
    </Button>
  );
}

/**
 * Searchable list of synced repositories.
 *
 * Filtering is client-side: the repository cache is small and local, so an
 * instant filter beats a round trip.
 */
export function RepoList({ repos }: { repos: HubRepository[] }) {
  const [query, setQuery] = useState("");
  const [onlyUnlinked, setOnlyUnlinked] = useState(false);

  const needle = query.trim().toLowerCase();
  const filtered = repos.filter((repo) => {
    if (onlyUnlinked && repo.linkedProjectId) return false;
    if (!needle) return true;
    return (
      repo.name.toLowerCase().includes(needle) ||
      repo.fullName.toLowerCase().includes(needle) ||
      (repo.description ?? "").toLowerCase().includes(needle) ||
      (repo.language ?? "").toLowerCase().includes(needle) ||
      repo.topics.some((topic) => topic.includes(needle))
    );
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint"
            strokeWidth={1.75}
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter repositories…"
            aria-label="Filter repositories"
            className="h-8 w-full rounded-md border border-line bg-[var(--bg-subtle)] pl-8 pr-2.5 text-[13px] text-fg placeholder:text-faint hover:border-[var(--border-strong)] focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-soft)]"
          />
        </div>
        <label className="flex h-8 cursor-pointer select-none items-center gap-1.5 rounded-md border border-line bg-[var(--bg-subtle)] px-2.5 text-[12.5px] text-muted hover:border-[var(--border-strong)]">
          <input
            type="checkbox"
            checked={onlyUnlinked}
            onChange={(e) => setOnlyUnlinked(e.target.checked)}
            className="h-3 w-3 accent-[var(--accent)]"
          />
          Not on dashboard
        </label>
        <span className="text-[12px] text-faint">
          {filtered.length} of {repos.length}
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <ul className="divide-y divide-[var(--border)]">
          {filtered.map((repo) => (
            <li
              key={repo.externalId}
              className="flex flex-wrap items-start gap-3 px-4 py-3 transition-colors hover:bg-[var(--bg-subtle)]"
            >
              <div className="min-w-56 flex-1">
                <div className="flex items-center gap-1.5">
                  <a
                    href={repo.htmlUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate text-[13.5px] font-medium text-fg transition-colors hover:text-[var(--accent-text)]"
                  >
                    {repo.name}
                  </a>
                  {repo.isPrivate ? (
                    <Lock className="h-3 w-3 shrink-0 text-faint" strokeWidth={2} />
                  ) : null}
                  {repo.isFork ? <Badge className="text-faint">fork</Badge> : null}
                </div>

                <p className="mt-0.5 line-clamp-1 text-[12.5px] text-muted">
                  {repo.description ?? "No description"}
                </p>

                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
                  {repo.language ? (
                    <span className="flex items-center gap-1.5">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: languageColor(repo.language) }}
                        aria-hidden
                      />
                      {repo.language}
                    </span>
                  ) : null}
                  {repo.stars > 0 ? (
                    <span className="flex items-center gap-1">
                      <StarIcon className="h-3 w-3" strokeWidth={1.75} />
                      {formatCompact(repo.stars)}
                    </span>
                  ) : null}
                  {repo.forks > 0 ? (
                    <span className="flex items-center gap-1">
                      <GitFork className="h-3 w-3" strokeWidth={1.75} />
                      {formatCompact(repo.forks)}
                    </span>
                  ) : null}
                  {repo.openIssues > 0 ? (
                    <span className="flex items-center gap-1">
                      <CircleDot className="h-3 w-3" strokeWidth={1.75} />
                      {repo.openIssues}
                    </span>
                  ) : null}
                  <span className="font-mono">{repo.defaultBranch}</span>
                  <span>updated {formatRelative(repo.pushedAt)}</span>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <a
                  href={githubLinks.repo(repo.htmlUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open on GitHub"
                  className={buttonClasses("ghost", "icon")}
                >
                  <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
                </a>
                <AddButton repo={repo} />
              </div>
            </li>
          ))}
        </ul>

        {filtered.length === 0 ? (
          <p className="px-4 py-10 text-center text-[13px] text-faint">
            No repositories match “{query}”.
          </p>
        ) : null}
      </div>
    </div>
  );
}

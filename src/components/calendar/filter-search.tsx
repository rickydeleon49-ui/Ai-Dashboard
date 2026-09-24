"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { StaleWorkspaceError, searchFilterOptions } from "./calendar-api";

type Result = { id: string; name: string | null };
// Every non-idle state records the workspace it belongs to; one for another
// workspace is never rendered.
type State =
  | { status: "idle" }
  | { status: "loading"; ws: string }
  | { status: "ready"; ws: string; q: string; results: Result[]; nextCursor: string | null }
  | { status: "error"; ws: string; q: string };

const DEBOUNCE_MS = 300;

/**
 * Finds a filter value that isn't in the initial (capped) option list
 * (design note §3). Searches are debounced, or sent at once on Enter.
 *
 * Requests belong to a generation. Any edit of the text, new search, workspace
 * change or unmount starts a new generation: it aborts the in-flight request
 * (first page or "More matches"), cancels the pending debounce and drops the
 * results on screen. A response, error or `finally` from an older generation
 * changes nothing — so results for text the box no longer contains are never
 * shown or appended, and a stale request can't end a newer one's loading state.
 */
export function FilterSearch({
  workspaceId,
  type,
  noun,
  disabled,
  onSelect,
}: {
  workspaceId: string;
  type: "projects" | "members";
  /** Plural noun for labels and messages, e.g. "projects". */
  noun: string;
  disabled: boolean;
  onSelect: (result: { id: string; name: string }) => void;
}) {
  const [text, setText] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The trimmed query this generation has searched (or is searching). */
  const searched = useRef<string | null>(null);
  const inputId = useId();
  const listId = useId();
  const statusId = useId();
  const fallbackName = type === "members" ? "Unnamed member" : "Untitled project";

  // Starts a new generation: nothing already in flight can apply afterwards.
  function invalidate() {
    generation.current += 1;
    controller.current?.abort();
    controller.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    searched.current = null;
  }

  useEffect(
    () => () => {
      generation.current += 1;
      controller.current?.abort();
      if (timer.current) clearTimeout(timer.current);
    },
    [workspaceId, type],
  );

  function run(query: string) {
    const q = query.trim();
    if (q && q === searched.current) return; // this exact search is already in flight or on screen
    invalidate();
    setLoadingMore(false);
    if (!q) {
      setState({ status: "idle" });
      return;
    }
    const gen = generation.current;
    const ws = workspaceId;
    const abort = new AbortController();
    controller.current = abort;
    searched.current = q;
    setState({ status: "loading", ws });
    searchFilterOptions(ws, type, q, null, abort.signal)
      .then((page) => {
        if (gen !== generation.current || page.q !== q) return;
        setState({ status: "ready", ws, q, results: page.results, nextCursor: page.nextCursor });
      })
      .catch((error: unknown) => {
        if (gen !== generation.current || abort.signal.aborted || error instanceof StaleWorkspaceError) return;
        searched.current = null; // allow Retry / Enter to search again
        setState({ status: "error", ws, q });
      });
  }

  async function loadMore() {
    if (state.status !== "ready" || !state.nextCursor || loadingMore) return;
    const gen = generation.current;
    const { ws, q, nextCursor } = state;
    const abort = new AbortController();
    controller.current = abort;
    setLoadingMore(true);
    try {
      const page = await searchFilterOptions(ws, type, q, nextCursor, abort.signal);
      if (gen !== generation.current || page.q !== q) return;
      setState((prev) =>
        prev.status === "ready" && prev.q === q && prev.nextCursor === nextCursor
          ? {
              ...prev,
              results: [...prev.results, ...page.results.filter((r) => !prev.results.some((p) => p.id === r.id))],
              nextCursor: page.nextCursor,
            }
          : prev,
      );
    } catch (error) {
      if (gen !== generation.current || abort.signal.aborted || error instanceof StaleWorkspaceError) return;
      searched.current = null;
      setState({ status: "error", ws, q });
    } finally {
      if (gen === generation.current) setLoadingMore(false);
    }
  }

  const view: State = state.status !== "idle" && state.ws !== workspaceId ? { status: "idle" } : state;

  const message =
    view.status === "loading"
      ? `Searching ${noun}…`
      : view.status === "error"
        ? `Couldn’t search ${noun}. Try again.`
        : view.status === "ready"
          ? view.results.length === 0
            ? `No ${noun} match “${view.q}”.`
            : `${view.results.length} ${view.results.length === 1 ? "match" : "matches"}${view.nextCursor ? " shown; more below" : ""}.`
          : `Type part of a name to find ${noun} not listed above.`;

  return (
    <div className="flex w-56 flex-col gap-1" data-testid={`filter-search-${type}`}>
      <label htmlFor={inputId} className="text-muted">
        Search {noun}
      </label>
      <input
        id={inputId}
        type="search"
        value={text}
        disabled={disabled}
        maxLength={100}
        autoComplete="off"
        aria-controls={listId}
        aria-describedby={statusId}
        onChange={(e) => {
          const value = e.target.value;
          setText(value);
          const q = value.trim();
          if (q && q === searched.current) return; // e.g. a trailing space: the results still match
          // The old results no longer match the box: drop them and anything in flight at once.
          invalidate();
          setLoadingMore(false);
          if (!q) {
            setState({ status: "idle" });
            return;
          }
          setState({ status: "loading", ws: workspaceId });
          timer.current = setTimeout(() => run(value), DEBOUNCE_MS);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            run(text);
          }
        }}
        className="h-8 rounded-md border border-line bg-surface px-2 text-[13px] text-fg"
      />
      <p id={statusId} role="status" aria-live="polite" aria-busy={view.status === "loading"} className="text-[11px] text-faint">
        {message}
      </p>
      {view.status === "error" ? (
        <Button type="button" size="sm" variant="outline" onClick={() => run(view.q)}>
          Retry search
        </Button>
      ) : null}
      {view.status === "ready" && view.results.length > 0 ? (
        <ul id={listId} aria-label={`Matching ${noun}`} className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-line p-1">
          {view.results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onSelect({ id: r.id, name: r.name ?? fallbackName })}
                className="w-full rounded px-1.5 py-1 text-left text-[12px] text-fg hover:bg-[var(--bg-subtle)] focus-visible:bg-[var(--bg-subtle)] disabled:opacity-50"
              >
                {r.name ?? fallbackName}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ul id={listId} aria-label={`Matching ${noun}`} hidden />
      )}
      {view.status === "ready" && view.nextCursor ? (
        <Button type="button" size="sm" variant="ghost" disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? "Loading…" : "More matches"}
        </Button>
      ) : null}
    </div>
  );
}

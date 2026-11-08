"use client";

import { useEffect, useState } from "react";
import type { UsageSnapshot } from "@/core/usage";

export const USAGE_POLL_MS = 60_000;

export interface UsageState {
  snapshot: UsageSnapshot | null;
  /** True until the first fetch settles. */
  loading: boolean;
  error: string | null;
}

/**
 * One shared store: the page and the sidebar both call `useUsageSnapshot()`,
 * but there is a single 60 s poll (plus a refetch on window focus) while at
 * least one of them is mounted.
 */
let state: UsageState = { snapshot: null, loading: true, error: null };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let lastFetchAt = 0;

function setState(next: UsageState) {
  state = next;
  for (const l of listeners) l();
}

export async function refreshUsage(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  lastFetchAt = Date.now();
  try {
    const res = await fetch("/api/usage", { cache: "no-store" });
    if (!res.ok) {
      setState({ ...state, loading: false, error: `Usage unavailable (${res.status})` });
      return;
    }
    const snapshot = (await res.json()) as UsageSnapshot;
    setState({ snapshot, loading: false, error: null });
  } catch {
    setState({ ...state, loading: false, error: "Could not reach the usage service" });
  } finally {
    inFlight = false;
  }
}

function onFocus() {
  // Avoid hammering when focus flickers.
  if (Date.now() - lastFetchAt > 5_000) void refreshUsage();
}

function start() {
  void refreshUsage();
  timer = setInterval(() => void refreshUsage(), USAGE_POLL_MS);
  window.addEventListener("focus", onFocus);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  window.removeEventListener("focus", onFocus);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

export function useUsageSnapshot(): UsageState & { refresh: () => Promise<void> } {
  const [local, setLocal] = useState<UsageState>(state);
  useEffect(() => {
    const sync = () => setLocal(state);
    const unsubscribe = subscribe(sync);
    sync();
    return unsubscribe;
  }, []);
  return { ...local, refresh: refreshUsage };
}

/** A clock that re-renders every `ms`, so "12 min ago" stays honest between polls. */
export function useNow(ms = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Loader2,
  PauseCircle,
  Search,
  User,
  UserX,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type {
  WorkspaceMemberDisplaySummary,
  WorkspaceMemberSummary,
} from "@/core/workspaces/types";
import { cn } from "@/lib/utils";

export function getMemberInitials(name: string | null, email: string | null): string {
  if (name && name.trim().length > 0) {
    const parts = name.trim().split(/\s+/);
    const first = parts[0];
    const second = parts[1];
    if (first && second && first[0] && second[0]) {
      return (first[0] + second[0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }
  if (email && email.length > 0) {
    return email.slice(0, 2).toUpperCase();
  }
  return "??";
}

export function AssigneeBadge({
  member,
  userId,
  fallbackName,
}: {
  member?: WorkspaceMemberDisplaySummary | null;
  userId?: string | null;
  fallbackName?: string | null;
}) {
  if (!userId && !member) return null;

  if (member?.status === "suspended") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-300"
        title="Assigned to suspended member"
      >
        <PauseCircle className="h-3 w-3 shrink-0 text-amber-400" aria-hidden="true" />
        <span className="max-w-[110px] truncate">{member.name || "Suspended user"}</span>
        <span className="shrink-0 text-amber-400/90 font-semibold">(Suspended)</span>
      </span>
    );
  }

  if (member?.status === "removed") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-300"
        title="Assigned to former member"
      >
        <XCircle className="h-3 w-3 shrink-0 text-red-400" aria-hidden="true" />
        <span className="max-w-[110px] truncate">{member.name || "Former member"}</span>
        <span className="shrink-0 text-red-400/90 font-semibold">(Former Member)</span>
      </span>
    );
  }

  const displayName = member?.name || member?.email || fallbackName || "Assigned";
  const initials = getMemberInitials(member?.name ?? null, member?.email ?? null);

  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-line bg-[var(--bg-subtle)] px-1.5 py-0.5 text-[11.5px] text-fg"
      title={`Assigned to ${displayName}`}
    >
      <span
        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[9px] font-semibold text-[var(--accent-text)]"
        aria-hidden="true"
      >
        {initials}
      </span>
      <span className="max-w-[110px] truncate">{displayName}</span>
    </span>
  );
}

interface AssigneePickerProps {
  workspaceId: string;
  value: string | null;
  onChange: (assigneeId: string | null) => void;
  knownMembers?: WorkspaceMemberDisplaySummary[];
  disabled?: boolean;
}

export function AssigneePicker({
  workspaceId,
  value,
  onChange,
  knownMembers = [],
  disabled = false,
}: AssigneePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [activeMembers, setActiveMembers] = useState<WorkspaceMemberSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Debounce search input by 300ms (matching workspace-members.tsx)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Build a lookup map of all known members (including historical)
  const memberMap = useMemo(() => {
    const map = new Map<string, WorkspaceMemberDisplaySummary>();
    for (const m of knownMembers) {
      map.set(m.id, m);
    }
    for (const m of activeMembers) {
      map.set(m.id, m);
    }
    return map;
  }, [knownMembers, activeMembers]);

  const currentMember = value ? memberMap.get(value) : null;
  const isHistorical =
    currentMember && (currentMember.status === "suspended" || currentMember.status === "removed");

  // Fetch active members when open with debounced search and cancellation of stale requests
  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    const controller = new AbortController();

    const params = new URLSearchParams({ status: "active", limit: "50" });
    if (debouncedSearch) {
      params.set("search", debouncedSearch);
    }

    fetch(`/api/workspaces/${workspaceId}/members?${params.toString()}`, {
      headers: { "Cache-Control": "no-store" },
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { members: WorkspaceMemberSummary[] };
        if (active) {
          setActiveMembers(data.members.filter((m) => m.status === "active"));
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!active || (err instanceof DOMException && err.name === "AbortError")) return;
        setActiveMembers(
          knownMembers.filter((m): m is WorkspaceMemberSummary => m.status === "active" && Boolean(m.role)),
        );
        setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [isOpen, debouncedSearch, workspaceId, knownMembers]);

  // Handle outside click to close
  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const filteredMembers = activeMembers.filter((m) => {
    if (!debouncedSearch) return true;
    const q = debouncedSearch.toLowerCase();
    return m.name?.toLowerCase().includes(q) || m.email?.toLowerCase().includes(q);
  });

  // Total selectable items: "Unassigned" (index 0) + filteredMembers (index 1..N)
  const totalItems = 1 + filteredMembers.length;

  function openPicker() {
    setLoading(true);
    setIsOpen(true);
    setSearch("");
    setDebouncedSearch("");
    setFocusedIndex(-1);
  }

  function closePicker() {
    setIsOpen(false);
    setSearch("");
    setDebouncedSearch("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!isOpen) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openPicker();
      }
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      closePicker();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIndex((prev) => (prev + 1) % totalItems);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex((prev) => (prev - 1 + totalItems) % totalItems);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (focusedIndex === 0) {
        onChange(null);
        closePicker();
      } else if (focusedIndex > 0 && focusedIndex <= filteredMembers.length) {
        const target = filteredMembers[focusedIndex - 1];
        if (target) {
          onChange(target.id);
          closePicker();
        }
      }
    }
  }

  return (
    <div className="relative space-y-1.5" ref={containerRef} onKeyDown={handleKeyDown}>
      {/* Historical suspended or removed read-only chip */}
      {isHistorical ? (
        <div
          className={cn(
            "flex items-center justify-between gap-2 rounded-md border p-2 text-[12px]",
            currentMember.status === "suspended"
              ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
              : "border-red-500/30 bg-red-500/10 text-red-300",
          )}
          role="status"
          aria-live="polite"
        >
          <div className="flex min-w-0 items-center gap-2">
            {currentMember.status === "suspended" ? (
              <PauseCircle className="h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
            ) : (
              <XCircle className="h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
            )}
            <div className="min-w-0 truncate">
              <span className="font-semibold text-fg">
                {currentMember.name || "Historical assignee"}
              </span>{" "}
              <span className="font-semibold">
                {currentMember.status === "suspended" ? "(Suspended)" : "(Former Member)"}
              </span>
              <p className="text-[11px] opacity-80">
                Historical assignee cannot be re-selected once changed.
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={disabled}
            onClick={() => (isOpen ? closePicker() : openPicker())}
            className="shrink-0 rounded px-2 py-1 text-[11.5px] font-medium underline underline-offset-2 transition-colors hover:text-fg disabled:opacity-50"
          >
            Change
          </button>
        </div>
      ) : null}

      {/* Main Trigger Button */}
      {!isHistorical ? (
        <button
          type="button"
          id="assignee-picker-trigger"
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-label={value && currentMember ? `Assignee: ${currentMember.name || currentMember.email || "assigned"}` : "Select assignee"}
          disabled={disabled}
          onClick={() => (isOpen ? closePicker() : openPicker())}
          className={cn(
            "flex h-8 w-full items-center justify-between rounded-md border border-line bg-[var(--bg-subtle)] px-2.5 text-[13px] text-fg transition-colors",
            "hover:border-[var(--border-strong)] focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-soft)]",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          <div className="flex min-w-0 items-center gap-2 truncate">
            {currentMember ? (
              <>
                <span
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[9px] font-semibold text-[var(--accent-text)]"
                  aria-hidden="true"
                >
                  {getMemberInitials(currentMember.name, currentMember.email ?? null)}
                </span>
                <span className="truncate">{currentMember.name || currentMember.email}</span>
                {currentMember.role ? (
                  <Badge className="shrink-0 text-[10px] uppercase tracking-wider py-0 px-1 text-muted bg-surface/50">
                    {currentMember.role}
                  </Badge>
                ) : null}
              </>
            ) : (
              <>
                <User className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden="true" />
                <span className="text-faint">Unassigned</span>
              </>
            )}
          </div>
          <ChevronDown
            className={cn("h-3.5 w-3.5 shrink-0 text-faint transition-transform", isOpen && "rotate-180")}
            aria-hidden="true"
          />
        </button>
      ) : null}

      {/* Dropdown Popover */}
      {isOpen ? (
        <div
          className="absolute left-0 right-0 z-50 mt-1 max-h-64 w-full rounded-md border border-line bg-surface p-1 shadow-lg"
          role="listbox"
          aria-label="Active workspace members"
          ref={listRef}
        >
          {/* Search bar */}
          <div className="relative mb-1 px-1 pt-1">
            <Search
              className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint"
              aria-hidden="true"
            />
            <input
              autoFocus
              type="text"
              aria-label="Search active members by name or email"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search active members..."
              className="h-7 w-full rounded border border-line bg-[var(--bg-subtle)] pl-7 pr-2 text-[12px] text-fg placeholder:text-faint focus:border-[var(--accent)] focus:outline-none"
            />
          </div>

          <div className="max-h-48 overflow-y-auto py-1">
            {/* Unassigned Option */}
            <div
              role="option"
              aria-selected={value === null}
              tabIndex={0}
              onClick={() => {
                onChange(null);
                closePicker();
              }}
              className={cn(
                "flex cursor-pointer items-center justify-between rounded px-2 py-1.5 text-[12.5px] transition-colors",
                value === null
                  ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-text)]"
                  : "text-muted hover:bg-[var(--bg-subtle)] hover:text-fg",
                focusedIndex === 0 && "ring-1 ring-[var(--accent)]",
              )}
            >
              <div className="flex items-center gap-2">
                <UserX className="h-3.5 w-3.5 text-faint" aria-hidden="true" />
                <span>Unassigned</span>
              </div>
              {value === null ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-3 text-faint">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              </div>
            ) : filteredMembers.length === 0 ? (
              <p className="px-2 py-2 text-center text-[11.5px] text-faint">
                No active members found
              </p>
            ) : (
              filteredMembers.map((member, idx) => {
                const isSelected = value === member.id;
                const isFocused = focusedIndex === idx + 1;
                return (
                  <div
                    key={member.id}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={0}
                    onClick={() => {
                      onChange(member.id);
                      closePicker();
                    }}
                    className={cn(
                      "flex cursor-pointer items-center justify-between rounded px-2 py-1.5 text-[12.5px] transition-colors",
                      isSelected
                        ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-text)]"
                        : "text-muted hover:bg-[var(--bg-subtle)] hover:text-fg",
                      isFocused && "ring-1 ring-[var(--accent)]",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-raised text-[10px] font-semibold text-fg"
                        aria-hidden="true"
                      >
                        {getMemberInitials(member.name, member.email)}
                      </span>
                      <div className="min-w-0 truncate">
                        <p className="truncate text-fg font-medium">
                          {member.name || member.email}
                        </p>
                        {member.name && member.email ? (
                          <p className="truncate text-[11px] text-faint">{member.email}</p>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5 pl-2">
                      <Badge className="text-[10px] uppercase tracking-wider py-0 px-1 text-muted bg-surface/80">
                        {member.role}
                      </Badge>
                      {isSelected ? (
                        <Check className="h-3.5 w-3.5 text-[var(--accent-text)]" aria-hidden="true" />
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

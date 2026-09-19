"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Mail,
  PauseCircle,
  RotateCcw,
  Search,
  Trash2,
  UserCheck,
  Users,
  X,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import type {
  WorkspaceMemberStatus,
  WorkspaceMemberSummary,
  WorkspaceRole,
} from "@/core/workspaces/types";

const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

const STATUS_LABELS: Record<WorkspaceMemberStatus, string> = {
  active: "Active",
  invited: "Invited",
  suspended: "Suspended",
  removed: "Removed",
};

interface WorkspaceMembersProps {
  workspaceId: string;
  callerRole: WorkspaceRole;
  currentUserId: string | null;
}

const PAGE_SIZE = 10;

function getInitials(name: string | null, email: string | null): string {
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

function RoleBadge({ role }: { role: WorkspaceRole }) {
  switch (role) {
    case "owner":
      return (
        <Badge className="bg-amber-500/10 text-amber-400 ring-amber-500/30">
          Owner
        </Badge>
      );
    case "admin":
      return (
        <Badge className="bg-purple-500/10 text-purple-400 ring-purple-500/30">
          Admin
        </Badge>
      );
    case "member":
      return (
        <Badge className="bg-blue-500/10 text-blue-400 ring-blue-500/30">
          Member
        </Badge>
      );
    case "viewer":
    default:
      return (
        <Badge className="bg-zinc-500/10 text-zinc-400 ring-zinc-500/30">
          Viewer
        </Badge>
      );
  }
}

function StatusBadge({ status }: { status: WorkspaceMemberStatus }) {
  switch (status) {
    case "active":
      return (
        <span
          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-emerald-400"
          title="Active member"
        >
          <Check className="h-3 w-3" aria-hidden="true" />
          <span>Active</span>
        </span>
      );
    case "suspended":
      return (
        <span
          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-amber-400"
          title="Suspended member"
        >
          <PauseCircle className="h-3 w-3" aria-hidden="true" />
          <span>Suspended</span>
        </span>
      );
    case "removed":
      return (
        <span
          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-red-400"
          title="Removed member"
        >
          <XCircle className="h-3 w-3" aria-hidden="true" />
          <span>Removed</span>
        </span>
      );
    case "invited":
    default:
      return (
        <span
          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-sky-400"
          title="Pending invitation"
        >
          <Mail className="h-3 w-3" aria-hidden="true" />
          <span>Invited</span>
        </span>
      );
  }
}

export function WorkspaceMembers({
  workspaceId,
  callerRole,
  currentUserId,
}: WorkspaceMembersProps) {
  const [members, setMembers] = useState<WorkspaceMemberSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});

  // Confirmation dialog state
  const [memberToRemove, setMemberToRemove] = useState<WorkspaceMemberSummary | null>(null);
  const [removeDialogError, setRemoveDialogError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const triggerButtonRef = useRef<HTMLButtonElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  const isElevated = callerRole === "owner" || callerRole === "admin";

  const [refreshKey, setRefreshKey] = useState(0);

  // Debounce search input by 300ms
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Synchronize members list from server
  useEffect(() => {
    let active = true;

    const offset = (page - 1) * PAGE_SIZE;
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });

    if (debouncedSearch) {
      params.set("search", debouncedSearch);
    }

    if (isElevated && statusFilter !== "active") {
      params.set("status", statusFilter);
    }

    fetch(`/api/workspaces/${workspaceId}/members?${params.toString()}`, {
      headers: { "Cache-Control": "no-store" },
    })
      .then(async (res) => {
        const data = (await res.json()) as {
          members?: WorkspaceMemberSummary[];
          total?: number;
          error?: string;
        };
        if (!active) return;
        if (!res.ok) {
          setError(data.error ?? "Failed to load workspace members.");
        } else {
          const newTotal = data.total ?? 0;
          setTotal(newTotal);
          const maxPage = Math.max(1, Math.ceil(newTotal / PAGE_SIZE));
          if (newTotal > 0 && page > maxPage) {
            setPage(maxPage);
            return;
          }
          setMembers(data.members ?? []);
          setError(null);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setError("Network error: failed to communicate with server.");
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [workspaceId, page, debouncedSearch, statusFilter, isElevated, refreshKey]);

  // Role change handler
  const handleRoleChange = async (targetMember: WorkspaceMemberSummary, newRole: WorkspaceRole) => {
    if (targetMember.role === newRole) return;
    setActionLoading((prev) => ({ ...prev, [targetMember.id]: true }));
    setError(null);

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/members/${targetMember.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: newRole }),
      });

      const data = (await res.json()) as { member?: WorkspaceMemberSummary; error?: string };

      if (!res.ok) {
        setError(data.error ?? "Failed to update member role.");
        return;
      }

      setMembers((prev) =>
        prev.map((m) => (m.id === targetMember.id && data.member ? data.member : m)),
      );
      setRefreshKey((k) => k + 1);
    } catch {
      setError("Network error: failed to update member role.");
    } finally {
      setActionLoading((prev) => ({ ...prev, [targetMember.id]: false }));
    }
  };

  // Status toggle handler (suspend or reinstate)
  const handleStatusChange = async (
    targetMember: WorkspaceMemberSummary,
    newStatus: WorkspaceMemberStatus,
  ) => {
    setActionLoading((prev) => ({ ...prev, [targetMember.id]: true }));
    setError(null);

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/members/${targetMember.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });

      const data = (await res.json()) as { member?: WorkspaceMemberSummary; error?: string };

      if (!res.ok) {
        setError(data.error ?? "Failed to update member status.");
        return;
      }

      // If filtering by a specific status, re-load list to reflect filter
      if (statusFilter !== "all") {
        setLoading(true);
        setRefreshKey((k) => k + 1);
      } else {
        setMembers((prev) =>
          prev.map((m) => (m.id === targetMember.id && data.member ? data.member : m)),
        );
      }
    } catch {
      setError("Network error: failed to update member status.");
    } finally {
      setActionLoading((prev) => ({ ...prev, [targetMember.id]: false }));
    }
  };

  // Open removal confirmation dialog
  const openRemoveDialog = (
    member: WorkspaceMemberSummary,
    buttonElem: HTMLButtonElement,
  ) => {
    triggerButtonRef.current = buttonElem;
    setMemberToRemove(member);
    setRemoveDialogError(null);
  };

  // Focus cancel button on dialog open
  useEffect(() => {
    if (memberToRemove && cancelButtonRef.current) {
      cancelButtonRef.current.focus();
    }
  }, [memberToRemove]);

  // Execute soft removal
  const handleConfirmRemove = async () => {
    if (!memberToRemove) return;
    setRemoving(true);
    setRemoveDialogError(null);

    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/members/${memberToRemove.id}`,
        {
          method: "DELETE",
        },
      );

      const data = (await res.json()) as { ok?: boolean; error?: string };

      if (!res.ok) {
        setRemoveDialogError(data.error ?? "Failed to remove member.");
        return;
      }

      // Success: close dialog and refresh
      setMemberToRemove(null);
      if (triggerButtonRef.current) {
        triggerButtonRef.current.focus();
      }
      setLoading(true);
      setRefreshKey((k) => k + 1);
    } catch {
      setRemoveDialogError("Network error: failed to remove member.");
    } finally {
      setRemoving(false);
    }
  };

  const closeRemoveDialog = () => {
    setMemberToRemove(null);
    setRemoveDialogError(null);
    if (triggerButtonRef.current) {
      triggerButtonRef.current.focus();
    }
  };

  // Check if caller can modify a given target member
  const canModify = (target: WorkspaceMemberSummary): boolean => {
    if (target.id === currentUserId) return false;
    if (target.status === "removed") return false;
    if (callerRole === "owner") return true;
    if (callerRole === "admin") {
      // Admins can only modify members and viewers, not owners or other admins
      return target.role === "member" || target.role === "viewer";
    }
    return false;
  };

  // Available roles caller can assign to target
  const getAssignableRoles = (): WorkspaceRole[] => {
    if (callerRole === "owner") {
      return ["owner", "admin", "member", "viewer"];
    }
    if (callerRole === "admin") {
      return ["member", "viewer"];
    }
    return [];
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      {/* Top Search & Filter Bar */}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1">
          <Search
            className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint"
            aria-hidden="true"
          />
          <Input
            type="search"
            placeholder="Search by name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 text-[12.5px]"
            aria-label="Search members"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-faint hover:text-fg"
              aria-label="Clear search"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {isElevated && (
          <div className="flex items-center gap-2">
            <label
              htmlFor="member-status-filter"
              className="shrink-0 text-[12px] font-medium text-muted"
            >
              Status:
            </label>
            <Select
              id="member-status-filter"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="h-8 text-[12.5px]"
              aria-label="Filter members by status"
            >
              <option value="active">Active only</option>
              <option value="suspended">Suspended</option>
              <option value="removed">Removed</option>
              <option value="all">All statuses</option>
            </Select>
          </div>
        )}
      </div>

      {/* Global Error Banner */}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-[12.5px] text-red-300"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
          <div className="flex-1">{error}</div>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-200"
            aria-label="Dismiss error"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Members List */}
      <div className="rounded-lg border border-line bg-[var(--bg-subtle)] overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center p-8 text-faint">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            <span className="text-[13px]">Loading directory...</span>
          </div>
        ) : members.length === 0 ? (
          <div className="p-8 text-center">
            <Users className="mx-auto mb-2 h-6 w-6 text-faint" aria-hidden="true" />
            <p className="text-[13px] font-medium text-fg">No members found</p>
            <p className="text-[12px] text-muted">
              {debouncedSearch
                ? "Try searching with a different name or email."
                : "No members match the current status filter."}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-line" role="list" aria-label="Workspace members list">
            {members.map((member) => {
              const isSelf = member.id === currentUserId;
              const modifying = actionLoading[member.id] ?? false;
              const editable = canModify(member);
              const assignableRoles = getAssignableRoles();

              return (
                <li
                  key={member.id}
                  className="flex flex-col gap-3 p-3 transition-colors hover:bg-[var(--bg-hover)] sm:flex-row sm:items-center sm:justify-between"
                >
                  {/* Member Avatar & Details */}
                  <div className="flex items-center gap-3 min-w-0">
                    {member.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={member.image}
                        alt={member.name || member.email || "Member avatar"}
                        className="h-8 w-8 shrink-0 rounded-full border border-line object-cover"
                      />
                    ) : (
                      <div
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-[var(--bg-hover)] text-[11.5px] font-semibold text-fg select-none"
                        aria-hidden="true"
                      >
                        {getInitials(member.name, member.email)}
                      </div>
                    )}

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-[13px] font-medium text-fg">
                          {member.name || member.email}
                        </p>
                        {isSelf && (
                          <span className="rounded bg-[var(--border)] px-1.5 py-0.2 text-[10.5px] font-medium text-muted">
                            You
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-muted">
                        <span className="truncate">{member.email}</span>
                        <span>·</span>
                        <span>
                          Joined{" "}
                          {new Date(member.joinedAt).toLocaleDateString(undefined, {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Status, Role & Action Controls */}
                  <div className="flex flex-wrap items-center gap-2.5 self-end sm:self-center">
                    <StatusBadge status={member.status} />

                    {/* Role selector for editable members, or static RoleBadge */}
                    {editable && assignableRoles.length > 0 ? (
                      <div className="flex items-center">
                        <label htmlFor={`role-select-${member.id}`} className="sr-only">
                          Change role for {member.name || member.email}
                        </label>
                        <Select
                          id={`role-select-${member.id}`}
                          value={member.role}
                          disabled={modifying}
                          onChange={(e) =>
                            handleRoleChange(member, e.target.value as WorkspaceRole)
                          }
                          className="h-7 text-[12px] py-0 pr-6"
                        >
                          {assignableRoles.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </Select>
                      </div>
                    ) : (
                      <RoleBadge role={member.role} />
                    )}

                    {/* Suspend / Reinstate Button */}
                    {editable && (
                      <>
                        {member.status === "active" ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={modifying}
                            onClick={() => handleStatusChange(member, "suspended")}
                            title={`Suspend ${member.name || member.email}`}
                            aria-label={`Suspend ${member.name || member.email}`}
                            className="h-7 px-2 text-[11.5px]"
                          >
                            {modifying ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <PauseCircle className="h-3.5 w-3.5 text-amber-400" />
                            )}
                            <span className="hidden md:inline">Suspend</span>
                          </Button>
                        ) : member.status === "suspended" ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={modifying}
                            onClick={() => handleStatusChange(member, "active")}
                            title={`Reinstate ${member.name || member.email}`}
                            aria-label={`Reinstate ${member.name || member.email}`}
                            className="h-7 px-2 text-[11.5px]"
                          >
                            {modifying ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RotateCcw className="h-3.5 w-3.5 text-emerald-400" />
                            )}
                            <span className="hidden md:inline">Reinstate</span>
                          </Button>
                        ) : null}

                        {/* Remove Button */}
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={modifying}
                          onClick={(e) => openRemoveDialog(member, e.currentTarget)}
                          title={`Remove ${member.name || member.email}`}
                          aria-label={`Remove ${member.name || member.email}`}
                          className="h-7 px-2 text-[11.5px]"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          <span className="hidden md:inline">Remove</span>
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-2 pt-1 text-[12.5px] text-muted">
          <p>
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of{" "}
            <span className="font-medium text-fg">{total}</span> members
          </p>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              aria-label="Previous page"
              className="h-7 px-2"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              <span>Previous</span>
            </Button>
            <span className="px-2 font-medium text-fg">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              aria-label="Next page"
              className="h-7 px-2"
            >
              <span>Next</span>
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Accessible Remove Member Confirmation Dialog */}
      {memberToRemove && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="remove-dialog-title"
          aria-describedby="remove-dialog-description"
          onKeyDown={(e) => {
            if (e.key === "Escape") closeRemoveDialog();
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in duration-150"
        >
          <div className="w-full max-w-md rounded-xl border border-line bg-[var(--bg-subtle)] p-5 shadow-2xl space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 text-fg">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/10 text-red-400">
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </div>
                <h3 id="remove-dialog-title" className="text-[15px] font-semibold">
                  Remove Workspace Member
                </h3>
              </div>
              <button
                type="button"
                onClick={closeRemoveDialog}
                className="rounded text-faint hover:text-fg p-1"
                aria-label="Close dialog"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p id="remove-dialog-description" className="text-[13px] leading-relaxed text-muted">
              Are you sure you want to remove{" "}
              <strong className="text-fg font-medium">
                {memberToRemove.name || memberToRemove.email}
              </strong>{" "}
              from this workspace? They will lose access immediately. Their past task
              history and contributions will be safely preserved.
            </p>

            {removeDialogError && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-2.5 text-[12px] text-red-300"
              >
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
                <span>{removeDialogError}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <Button
                ref={cancelButtonRef}
                type="button"
                variant="outline"
                size="md"
                disabled={removing}
                onClick={closeRemoveDialog}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                size="md"
                disabled={removing}
                onClick={handleConfirmRemove}
                className="bg-red-500/15 hover:bg-red-500/25"
              >
                {removing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                <span>Remove Member</span>
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

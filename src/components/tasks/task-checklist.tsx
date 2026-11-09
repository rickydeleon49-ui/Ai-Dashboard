"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  CheckSquare,
  ListChecks,
  Loader2,
  Pencil,
  Plus,
  Square,
  Trash2,
  X,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import type { TaskChecklistItem } from "@/core/tasks/types";
import { MAX_CHECKLIST_ITEMS_PER_TASK } from "@/db/repositories/checklist-repository";
import { cn } from "@/lib/utils";

export interface TaskChecklistProps {
  taskId: string;
  isViewer?: boolean;
  onProgressChange?: (doneCount: number, totalCount: number) => void;
  onTaskCreated?: () => void;
}

export function TaskChecklistBadge({
  done,
  total,
}: {
  done: number;
  total: number;
}) {
  if (total === 0) return null;
  const allDone = done === total;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] tabular-nums font-medium transition-colors",
        allDone
          ? "bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20"
          : "bg-[var(--bg-subtle)] text-muted ring-1 ring-line",
      )}
      title={`Checklist: ${done} of ${total} completed`}
      aria-label={`Checklist: ${done} of ${total} items completed`}
    >
      <ListChecks className="h-3 w-3 shrink-0" strokeWidth={2} />
      <span>
        {done}/{total}
      </span>
    </span>
  );
}

export function TaskChecklist({
  taskId,
  isViewer = false,
  onProgressChange,
  onTaskCreated,
}: TaskChecklistProps) {
  const [items, setItems] = useState<TaskChecklistItem[]>([]);
  const [loadedTaskId, setLoadedTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onProgressChangeRef = useRef(onProgressChange);
  useEffect(() => {
    onProgressChangeRef.current = onProgressChange;
  });

  const loading = loadedTaskId !== taskId;

  // New item creation state
  const [newText, setNewText] = useState("");
  const [adding, setAdding] = useState(false);
  const addInputRef = useRef<HTMLInputElement>(null);

  // Inline item editing state
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // Convert confirmation state
  const [confirmingConvertId, setConfirmingConvertId] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);

  // Reordering state
  const [reordering, setReordering] = useState(false);

  // Fetch checklist items when taskId changes
  useEffect(() => {
    let active = true;

    fetch(`/api/tasks/${taskId}/checklist`)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? "Failed to load checklist");
        }
        return res.json() as Promise<{ items: TaskChecklistItem[] }>;
      })
      .then((data) => {
        if (!active) return;
        const sorted = [...data.items].sort((a, b) => a.position - b.position);
        setItems(sorted);
        setLoadedTaskId(taskId);
        setError(null);
        const doneCount = sorted.filter((i) => i.done).length;
        onProgressChangeRef.current?.(doneCount, sorted.length);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Error loading checklist");
        setLoadedTaskId(taskId);
      });

    return () => {
      active = false;
    };
  }, [taskId]);

  function updateItemsState(newItems: TaskChecklistItem[]) {
    const sorted = [...newItems].sort((a, b) => a.position - b.position);
    setItems(sorted);
    const doneCount = sorted.filter((i) => i.done).length;
    onProgressChange?.(doneCount, sorted.length);
  }

  // 1. Add item
  async function handleAddItem(e: React.FormEvent) {
    e.preventDefault();
    if (isViewer) return;
    const trimmed = newText.trim();
    if (!trimmed) return;

    if (items.length >= MAX_CHECKLIST_ITEMS_PER_TASK) {
      setError(`Task checklist cannot exceed ${MAX_CHECKLIST_ITEMS_PER_TASK} items.`);
      return;
    }

    setAdding(true);
    setError(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/checklist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
      });

      const body = (await res.json().catch(() => null)) as {
        item?: TaskChecklistItem;
        error?: string;
      } | null;

      if (!res.ok || !body?.item) {
        setError(body?.error ?? "Failed to add checklist item.");
        return;
      }

      updateItemsState([...items, body.item]);
      setNewText("");
      // Keep focus on input for fast rapid entry
      setTimeout(() => addInputRef.current?.focus(), 0);
    } catch {
      setError("Network error: Could not add checklist item.");
    } finally {
      setAdding(false);
    }
  }

  // 2. Toggle done / reopen
  async function handleToggleDone(item: TaskChecklistItem) {
    if (isViewer) return;
    setError(null);
    const targetDone = !item.done;

    // Optimistic update
    const previousItems = [...items];
    const updated = items.map((i) => (i.id === item.id ? { ...i, done: targetDone } : i));
    updateItemsState(updated);

    try {
      const res = await fetch(`/api/tasks/${taskId}/checklist/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ done: targetDone }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        updateItemsState(previousItems); // Revert on failure
        setError(body?.error ?? "Failed to update item status.");
        return;
      }

      const body = (await res.json()) as { item: TaskChecklistItem };
      updateItemsState(items.map((i) => (i.id === item.id ? body.item : i)));
    } catch {
      updateItemsState(previousItems);
      setError("Network error: Could not update item status.");
    }
  }

  // 3. Edit text inline
  function startEdit(item: TaskChecklistItem) {
    if (isViewer) return;
    setEditingItemId(item.id);
    setEditingText(item.text);
    setError(null);
  }

  function cancelEdit() {
    setEditingItemId(null);
    setEditingText("");
  }

  async function handleSaveEdit(itemId: string) {
    if (isViewer) return;
    const trimmed = editingText.trim();
    if (!trimmed) {
      setError("Item text cannot be empty.");
      return;
    }

    setSavingEdit(true);
    setError(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/checklist/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
      });

      const body = (await res.json().catch(() => null)) as {
        item?: TaskChecklistItem;
        error?: string;
      } | null;

      if (!res.ok || !body?.item) {
        setError(body?.error ?? "Failed to save item edit.");
        return;
      }

      updateItemsState(items.map((i) => (i.id === itemId ? body.item! : i)));
      cancelEdit();
    } catch {
      setError("Network error: Could not save item edit.");
    } finally {
      setSavingEdit(false);
    }
  }

  // 4. Delete item
  async function handleDelete(itemId: string) {
    if (isViewer) return;
    setError(null);

    const previousItems = [...items];
    const filtered = items
      .filter((i) => i.id !== itemId)
      .map((item, idx) => ({ ...item, position: idx }));
    updateItemsState(filtered);

    try {
      const res = await fetch(`/api/tasks/${taskId}/checklist/${itemId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        updateItemsState(previousItems);
        setError(body?.error ?? "Failed to delete checklist item.");
      }
    } catch {
      updateItemsState(previousItems);
      setError("Network error: Could not delete checklist item.");
    }
  }

  // 5. Reorder items (Move up / down)
  async function handleMove(index: number, direction: "up" | "down") {
    if (isViewer || reordering) return;
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= items.length) return;

    setError(null);
    setReordering(true);

    const newItems = [...items];
    const [moved] = newItems.splice(index, 1);
    newItems.splice(targetIndex, 0, moved!);

    const itemIds = newItems.map((i) => i.id);
    const optimistic = newItems.map((i, idx) => ({ ...i, position: idx }));
    const previousItems = [...items];
    updateItemsState(optimistic);

    try {
      const res = await fetch(`/api/tasks/${taskId}/checklist/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds }),
      });

      const body = (await res.json().catch(() => null)) as {
        items?: TaskChecklistItem[];
        error?: string;
      } | null;

      if (!res.ok || !body?.items) {
        updateItemsState(previousItems);
        setError(body?.error ?? "Failed to reorder checklist items.");
        return;
      }

      updateItemsState(body.items);
    } catch {
      updateItemsState(previousItems);
      setError("Network error: Could not reorder checklist items.");
    } finally {
      setReordering(false);
    }
  }

  // 6. Convert item to full task
  async function handleConvert(itemId: string) {
    if (isViewer || converting) return;
    setConverting(true);
    setError(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/checklist/${itemId}/convert`, {
        method: "POST",
      });

      const body = (await res.json().catch(() => null)) as {
        task?: unknown;
        error?: string;
      } | null;

      if (!res.ok || !body?.task) {
        setError(body?.error ?? "Failed to convert item to task.");
        return;
      }

      // Remove the converted item locally
      const remaining = items
        .filter((i) => i.id !== itemId)
        .map((i, idx) => ({ ...i, position: idx }));
      updateItemsState(remaining);
      setConfirmingConvertId(null);

      // Notify parent to refresh task list so converted task shows on board!
      onTaskCreated?.();
    } catch {
      setError("Network error: Could not convert checklist item.");
    } finally {
      setConverting(false);
    }
  }

  const doneCount = items.filter((i) => i.done).length;
  const totalCount = items.length;
  const percent = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2 text-[12px] text-faint">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Loading checklist...</span>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 min-w-0">
      {/* Header and Progress */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 pb-1.5 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[12.5px] font-medium text-fg">Checklist</span>
          {totalCount > 0 ? (
            <span
              className={cn(
                "rounded px-1.5 py-0.2 text-[11px] tabular-nums font-medium",
                doneCount === totalCount
                  ? "bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20"
                  : "bg-[var(--bg-subtle)] text-muted ring-1 ring-line",
              )}
            >
              {doneCount}/{totalCount} ({percent}%)
            </span>
          ) : null}
        </div>
      </div>

      {/* Inline Error Display */}
      {error ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 rounded border border-red-500/20 bg-red-500/10 px-2.5 py-1.5 text-[12px] text-red-400 min-w-0"
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
          <button
            type="button"
            onClick={() => setError(null)}
            className="rounded p-0.5 text-red-400 hover:text-red-300 min-h-[40px] min-w-[40px] md:min-h-0 md:min-w-0 flex items-center justify-center"
            aria-label="Dismiss error"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : null}

      {/* Checklist Items List */}
      {items.length === 0 ? (
        <p className="py-1 text-[12px] text-faint break-words">No checklist items yet.</p>
      ) : (
        <ul className="space-y-1.5 min-w-0" aria-label="Task checklist items">
          {items.map((item, index) => {
            const isEditing = editingItemId === item.id;
            const isConfirmingConvert = confirmingConvertId === item.id;

            return (
              <li
                key={item.id}
                className={cn(
                  "group flex flex-wrap sm:flex-nowrap items-center justify-between gap-2 rounded-md border border-line/50 bg-[var(--bg-subtle)]/50 px-2 py-1.5 text-[12.5px] transition-colors hover:border-line min-w-0",
                  item.done && "bg-[var(--bg-subtle)]/25",
                )}
              >
                {/* Left Side: Checkbox + Content */}
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={item.done}
                    aria-label={
                      item.done
                        ? `Mark "${item.text}" incomplete`
                        : `Mark "${item.text}" complete`
                    }
                    disabled={isViewer}
                    onClick={() => handleToggleDone(item)}
                    className={cn(
                      "flex h-6 w-6 min-h-[40px] min-w-[40px] md:min-h-0 md:min-w-0 md:h-4 md:w-4 shrink-0 items-center justify-center rounded border transition-colors",
                      item.done
                        ? "border-emerald-500/40 bg-emerald-500/20 text-emerald-400"
                        : "border-line bg-surface text-faint hover:border-[var(--accent-line)] hover:text-fg",
                      isViewer && "cursor-not-allowed opacity-75",
                    )}
                  >
                    {item.done ? (
                      <Check className="h-3 w-3 stroke-[2.5]" />
                    ) : (
                      <span className="sr-only">Incomplete</span>
                    )}
                  </button>

                  {isEditing ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        handleSaveEdit(item.id);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-1.5"
                    >
                      <Input
                        value={editingText}
                        onChange={(e) => setEditingText(e.target.value)}
                        maxLength={500}
                        autoFocus
                        disabled={savingEdit}
                        className="h-6.5 min-h-[40px] md:min-h-0 md:h-6.5 text-[12.5px]"
                        aria-label={`Edit text for item ${item.text}`}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") cancelEdit();
                        }}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        variant="primary"
                        disabled={savingEdit}
                        className="h-6.5 min-h-[40px] md:min-h-0 md:h-6.5 px-2 text-[11px]"
                        aria-label="Save item"
                      >
                        {savingEdit ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={cancelEdit}
                        disabled={savingEdit}
                        className="h-6.5 min-h-[40px] md:min-h-0 md:h-6.5 px-2 text-[11px]"
                        aria-label="Cancel editing"
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </form>
                  ) : (
                    <span
                      onDoubleClick={() => !isViewer && startEdit(item)}
                      className={cn(
                        "min-w-0 flex-1 break-words text-fg select-text",
                        item.done && "text-faint line-through",
                      )}
                    >
                      {item.text}
                    </span>
                  )}
                </div>

                {/* Right Side: Reorder & Actions */}
                {!isViewer && !isEditing ? (
                  <div className="flex shrink-0 items-center gap-0.5">
                    {isConfirmingConvert ? (
                      <div className="flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-300 ring-1 ring-amber-500/20">
                        <span>Convert to task?</span>
                        <button
                          type="button"
                          onClick={() => handleConvert(item.id)}
                          disabled={converting}
                          className="font-semibold text-emerald-400 hover:underline min-h-[40px] md:min-h-0 inline-flex items-center"
                        >
                          {converting ? "..." : "Yes"}
                        </button>
                        <span>/</span>
                        <button
                          type="button"
                          onClick={() => setConfirmingConvertId(null)}
                          disabled={converting}
                          className="text-faint hover:underline min-h-[40px] md:min-h-0 inline-flex items-center"
                        >
                          No
                        </button>
                      </div>
                    ) : (
                      <>
                        {/* Keyboard Reordering Buttons */}
                        <button
                          type="button"
                          onClick={() => handleMove(index, "up")}
                          disabled={index === 0 || reordering}
                          aria-label={`Move "${item.text}" up`}
                          title="Move up"
                          className={cn(
                            "flex h-8 w-8 min-h-[40px] min-w-[40px] md:min-h-0 md:min-w-0 md:h-6 md:w-6 items-center justify-center rounded text-faint transition-colors hover:text-fg",
                            index === 0 && "cursor-not-allowed opacity-25 hover:text-faint",
                          )}
                        >
                          <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.75} />
                        </button>

                        <button
                          type="button"
                          onClick={() => handleMove(index, "down")}
                          disabled={index === items.length - 1 || reordering}
                          aria-label={`Move "${item.text}" down`}
                          title="Move down"
                          className={cn(
                            "flex h-8 w-8 min-h-[40px] min-w-[40px] md:min-h-0 md:min-w-0 md:h-6 md:w-6 items-center justify-center rounded text-faint transition-colors hover:text-fg",
                            index === items.length - 1 && "cursor-not-allowed opacity-25 hover:text-faint",
                          )}
                        >
                          <ArrowDown className="h-3.5 w-3.5" strokeWidth={1.75} />
                        </button>

                        {/* Edit Button */}
                        <button
                          type="button"
                          onClick={() => startEdit(item)}
                          aria-label={`Edit "${item.text}"`}
                          title="Edit item"
                          className="flex h-8 w-8 min-h-[40px] min-w-[40px] md:min-h-0 md:min-w-0 md:h-6 md:w-6 items-center justify-center rounded text-faint transition-colors hover:text-fg"
                        >
                          <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                        </button>

                        {/* Convert to Task Button */}
                        <button
                          type="button"
                          onClick={() => setConfirmingConvertId(item.id)}
                          aria-label={`Convert "${item.text}" to full task`}
                          title="Convert to full task"
                          className="flex h-8 w-8 min-h-[40px] min-w-[40px] md:min-h-0 md:min-w-0 md:h-6 md:w-6 items-center justify-center rounded text-faint transition-colors hover:text-[var(--accent-text)]"
                        >
                          <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
                        </button>

                        {/* Delete Button */}
                        <button
                          type="button"
                          onClick={() => handleDelete(item.id)}
                          aria-label={`Delete "${item.text}"`}
                          title="Delete item"
                          className="flex h-8 w-8 min-h-[40px] min-w-[40px] md:min-h-0 md:min-w-0 md:h-6 md:w-6 items-center justify-center rounded text-faint transition-colors hover:text-red-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                        </button>
                      </>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {/* Add Item Form (Members, Admins, Owners, and Desktop) */}
      {!isViewer && items.length < MAX_CHECKLIST_ITEMS_PER_TASK ? (
        <form onSubmit={handleAddItem} className="flex flex-wrap sm:flex-nowrap items-center gap-1.5 pt-1 min-w-0">
          <Input
            ref={addInputRef}
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            maxLength={500}
            disabled={adding}
            placeholder="Add an item... (Enter to add)"
            className="h-7 min-h-[40px] md:min-h-0 md:h-7 text-[12px] min-w-0 flex-1"
            aria-label="New checklist item text"
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={adding || !newText.trim()}
            className="h-7 min-h-[40px] md:min-h-0 md:h-7 shrink-0 px-2.5 text-[11.5px]"
          >
            {adding ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <>
                <Plus className="h-3 w-3 mr-1" strokeWidth={2} />
                Add
              </>
            )}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

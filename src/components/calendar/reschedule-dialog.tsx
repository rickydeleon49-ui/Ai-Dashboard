"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { MAX_DATE, MIN_DATE, isDateOnly, type DateOnly } from "@/core/calendar/dates";

/**
 * The keyboard-accessible alternative to drag-and-drop (design note §6): a
 * native date input with explicit Save and Cancel. Escape cancels.
 */
export function RescheduleDialog({
  title,
  initialDate,
  saving,
  onSave,
  onCancel,
}: {
  title: string;
  initialDate: DateOnly | "";
  saving: boolean;
  onSave: (date: DateOnly) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState<string>(initialDate);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const valid = isDateOnly(value);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm space-y-3 rounded-xl border border-line bg-[var(--bg-elevated)] p-4 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSave(value);
        }}
      >
        <h2 id={titleId} className="text-sm font-semibold text-fg">
          Reschedule “{title}”
        </h2>
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          Due date
          <input
            ref={inputRef}
            type="date"
            required
            min={MIN_DATE}
            max={MAX_DATE}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-8 rounded-md border border-line bg-surface px-2 text-[13px] text-fg"
          />
        </label>
        {!valid && value !== "" ? (
          <p role="alert" className="text-[12px] text-red-400">
            Enter a valid date between Jan 1, 1900 and Dec 31, 9999.
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={!valid || saving}>
            Save
          </Button>
        </div>
      </form>
    </div>
  );
}

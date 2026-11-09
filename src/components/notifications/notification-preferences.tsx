"use client";

import { useEffect, useState } from "react";
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationPreferences as Preferences,
} from "@/core/notifications/types";
import { StaleWorkspaceError, fetchPreferences, savePreferences } from "./inbox-api";

const LABELS: Record<NotificationCategory, { title: string; description: string }> = {
  assignment: { title: "Assignments", description: "When someone assigns you a task or takes one off you." },
  mention: { title: "Mentions", description: "When someone mentions you in a task comment." },
  comment: { title: "Comments", description: "When someone comments on a task assigned to you." },
  due_date: { title: "Due-date changes", description: "When someone sets, moves or clears the due date on your task." },
};

/**
 * The caller's per-category preferences for the active workspace. Each toggle
 * saves only its own category, so changing one never resets another.
 */
export function NotificationPreferencesForm({ workspaceId }: { workspaceId: string }) {
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState<NotificationCategory | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchPreferences(workspaceId, controller.signal)
      .then((result) => setPreferences(result.preferences))
      .catch((err: unknown) => {
        if (controller.signal.aborted || err instanceof StaleWorkspaceError) return;
        setError("Couldn't load notification preferences.");
      });
    return () => controller.abort();
  }, [workspaceId]);

  async function toggle(category: NotificationCategory, enabled: boolean) {
    setSaving(category);
    setError(null);
    setStatus("");
    try {
      const result = await savePreferences(workspaceId, { [category]: enabled });
      setPreferences(result.preferences);
      setStatus(`${LABELS[category].title} notifications ${enabled ? "on" : "off"}.`);
    } catch (err) {
      if (err instanceof StaleWorkspaceError) return;
      setError("That preference didn't save. Try again.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <fieldset className="min-w-0 space-y-3">
      <legend className="text-sm font-semibold text-fg break-words">Notify me about</legend>
      <p className="text-[12px] text-muted break-words">
        These apply to this workspace only. Turning a category off stops new notifications of that kind; it
        doesn&apos;t remove ones you already have.
      </p>
      {error ? (
        <p role="alert" className="text-[13px] text-red-400 break-words">
          {error}
        </p>
      ) : null}
      {preferences === null && !error ? (
        <p role="status" className="text-[13px] text-muted">
          Loading preferences…
        </p>
      ) : null}
      {preferences ? (
        <ul className="min-w-0 space-y-2">
          {NOTIFICATION_CATEGORIES.map((category) => {
            const id = `notification-pref-${category}`;
            return (
              <li key={category} className="flex items-start gap-2.5 min-w-0">
                <input
                  id={id}
                  type="checkbox"
                  checked={preferences[category]}
                  disabled={saving !== null}
                  aria-describedby={`${id}-description`}
                  onChange={(event) => toggle(category, event.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-line bg-surface text-accent focus:ring-accent"
                />
                <div className="min-w-0 flex-1">
                  <label htmlFor={id} className="text-[13px] font-medium text-fg break-words">
                    {LABELS[category].title}
                  </label>
                  <p id={`${id}-description`} className="text-[12px] text-muted break-words">
                    {LABELS[category].description}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      <p role="status" aria-live="polite" className="text-[12px] text-muted break-words">
        {status}
      </p>
    </fieldset>
  );
}

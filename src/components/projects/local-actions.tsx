"use client";

import { useState, useSyncExternalStore } from "react";
import {
  AppWindow,
  FolderOpen,
  HardDrive,
  Loader2,
  SquareTerminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";

type Action = "app-terminal" | "folder" | "reveal" | "editor" | "terminal";

/**
 * Opening a project where the work actually happens.
 *
 * This is the thing a desktop app can do that a browser tab cannot, so it is a
 * row of real buttons rather than a path you copy and paste somewhere else.
 *
 * In a browser there is no bridge and no way to launch anything, so the path is
 * shown as text — the same information, minus a button that could not work.
 */

const BUTTONS: { action: Action; label: string; icon: typeof FolderOpen }[] = [
  { action: "app-terminal", label: "Terminal in app", icon: SquareTerminal },
  { action: "folder", label: "Open folder", icon: FolderOpen },
  { action: "editor", label: "Editor", icon: AppWindow },
  { action: "terminal", label: "System terminal", icon: SquareTerminal },
];

const subscribeToNothing = () => () => {};

export function LocalActions({
  projectId,
  localPath,
}: {
  projectId: string;
  localPath: string;
}) {
  // False during SSR and hydration, then whatever the bridge says. Reading
  // `window` during render would make the two disagree.
  const isDesktop = useSyncExternalStore(
    subscribeToNothing,
    () => typeof window !== "undefined" && Boolean(window.desktop),
    () => false,
  );

  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: Action) {
    setBusy(action);
    setError(null);
    try {
      const result = await window.desktop?.openLocal(projectId, action);
      if (result && !result.ok) setError(result.error);
    } catch {
      setError("The desktop shell did not respond.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
        Local folder
      </p>

      <p className="flex items-start gap-1.5 break-all font-mono text-[12px] text-fg">
        <HardDrive className="mt-0.5 h-3 w-3 shrink-0 text-faint" strokeWidth={1.75} />
        {localPath}
      </p>

      {isDesktop ? (
        <>
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {BUTTONS.map(({ action, label, icon: Icon }) => (
              <Button
                key={action}
                type="button"
                size="sm"
                onClick={() => run(action)}
                disabled={busy !== null}
              >
                {busy === action ? (
                  <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                ) : (
                  <Icon className="h-3 w-3" strokeWidth={1.75} />
                )}
                {label}
              </Button>
            ))}
          </div>

          {error ? (
            <p className="whitespace-pre-line text-[11.5px] leading-relaxed text-red-400">
              {error}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-[11.5px] leading-relaxed text-faint">
          Open this folder from the desktop app.
        </p>
      )}
    </div>
  );
}

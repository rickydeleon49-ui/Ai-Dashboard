"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { STORAGE_KEY } from "./theme-script";

type Theme = "dark" | "light" | "system";

/** Applies a theme choice to <html> and persists it. */
export function applyTheme(theme: Theme): void {
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : theme;
  document.documentElement.classList.toggle("light", resolved === "light");
  localStorage.setItem(STORAGE_KEY, theme);
}

const OPTIONS: { value: Theme; icon: typeof Sun; label: string }[] = [
  { value: "dark", icon: Moon, label: "Dark" },
  { value: "light", icon: Sun, label: "Light" },
  { value: "system", icon: Monitor, label: "System" },
];

/** Reads the stored choice. Returns the SSR default when there is no window. */
function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    return (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "dark";
  } catch {
    return "dark";
  }
}

const subscribeToNothing = () => () => {};

export function ThemeToggle() {
  // Lazy initialiser rather than an effect: the value is read once, during the
  // first client render, and never needs to be written back from an effect.
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  // False during SSR and the hydration render, true afterwards. Gating the
  // checked state on this keeps server and client markup identical.
  const mounted = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );

  // Keep "system" live when the OS preference changes mid-session.
  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const handler = () => applyTheme("system");
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, [theme]);

  function choose(next: Theme) {
    setTheme(next);
    applyTheme(next);
  }

  return (
    <div
      className="flex items-center gap-0.5 rounded-md border border-line bg-[var(--bg-subtle)] p-0.5"
      role="radiogroup"
      aria-label="Color theme"
    >
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={mounted && theme === option.value}
          aria-label={option.label}
          title={option.label}
          onClick={() => choose(option.value)}
          className={cn(
            "flex h-6 w-6 min-h-[40px] min-w-[40px] md:min-h-0 md:min-w-0 md:h-6 md:w-6 items-center justify-center rounded transition-colors",
            mounted && theme === option.value
              ? "bg-[var(--bg-hover)] text-fg"
              : "text-faint hover:text-muted",
          )}
        >
          <option.icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      ))}
    </div>
  );
}


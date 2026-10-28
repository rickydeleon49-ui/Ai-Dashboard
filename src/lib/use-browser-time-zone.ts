import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * The browser's IANA zone, or null during server rendering and hydration.
 * Components render zone-dependent output only once this is non-null.
 */
export function useBrowserTimeZone(): string | null {
  return useSyncExternalStore(
    noopSubscribe,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    () => null,
  );
}

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Connects the desktop menu to the client-side router.
 *
 * Renders nothing and does nothing in a browser — `window.desktop` only exists
 * when the preload bridge has run, so the same build serves web and desktop.
 * Menu items then navigate through the router instead of reloading the window.
 */
declare global {
  interface Window {
    desktop?: {
      isDesktop: boolean;
      platform: string;
      onNavigate: (callback: (route: string) => void) => () => void;
      openLocal: (
        projectId: string,
        action: "folder" | "reveal" | "editor" | "terminal",
      ) => Promise<{ ok: true } | { ok: false; error: string }>;
    };
  }
}

export function DesktopBridge() {
  const router = useRouter();

  useEffect(() => {
    const bridge = window.desktop;
    if (!bridge) return;

    document.documentElement.dataset.desktop = bridge.platform;
    return bridge.onNavigate((route) => router.push(route));
  }, [router]);

  return null;
}

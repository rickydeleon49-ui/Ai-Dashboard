"use client";

/**
 * Read-only xterm.js view of the run's events. Client only: it is loaded via
 * next/dynamic with ssr:false (see run-live.tsx). Disposed on unmount.
 *
 * Incremental: events with seq above the last written one are appended; if
 * the filter changes the terminal is reset and rewritten.
 */
import "@xterm/xterm/css/xterm.css";
import * as React from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { eventsToTerminalText, type UiEvent } from "./logic";

const SCROLLBACK = 5000;

export default function TerminalView({
  events,
  resetKey,
}: {
  events: UiEvent[];
  /** Changes when the visible set is not an append of the previous one (filter switch). */
  resetKey: string;
}) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const termRef = React.useRef<Terminal | null>(null);
  const writtenRef = React.useRef(0);
  const keyRef = React.useRef(resetKey);
  const eventsRef = React.useRef(events);
  React.useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  React.useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !hostRef.current) return;

      const term = new Terminal({
        disableStdin: true,
        scrollback: SCROLLBACK,
        convertEol: false,
        cursorBlink: false,
        cursorStyle: "bar",
        cursorInactiveStyle: "none",
        fontSize: 12,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        theme: { background: "#0b0c0f" },
        screenReaderMode: false,
      });
      const fit: FitAddon = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      try {
        fit.fit();
      } catch {
        // host not measurable yet; the resize observer will retry
      }
      termRef.current = term;
      writtenRef.current = 0;
      write(term, eventsRef.current);

      const observer = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          // ignore transient zero-size layouts
        }
      });
      observer.observe(hostRef.current);

      cleanup = () => {
        observer.disconnect();
        termRef.current = null;
        term.dispose();
      };
    })();

    function write(term: Terminal, evs: UiEvent[]) {
      const fresh = evs.filter((e) => e.seq > writtenRef.current);
      if (fresh.length === 0) return;
      term.write(eventsToTerminalText(fresh));
      writtenRef.current = fresh[fresh.length - 1]?.seq ?? writtenRef.current;
    }

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  React.useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (keyRef.current !== resetKey) {
      keyRef.current = resetKey;
      term.reset();
      writtenRef.current = 0;
    }
    const fresh = events.filter((e) => e.seq > writtenRef.current);
    if (fresh.length === 0) return;
    term.write(eventsToTerminalText(fresh));
    writtenRef.current = fresh[fresh.length - 1]?.seq ?? writtenRef.current;
  }, [events, resetKey]);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className="h-80 w-full max-w-full overflow-hidden rounded-md border border-line bg-[#0b0c0f] p-2"
    />
  );
}

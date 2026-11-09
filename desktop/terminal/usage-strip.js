/**
 * Terminal window usage strip. CSS for terminal.css:
 * .usage-strip-item { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 2px 6px; cursor: default; }
 * .usage-ok { color: #8b949e; } .usage-warn { color: #d29922; } .usage-danger { color: #f85149; }
 */
(function () {
  "use strict";

  const TOOLS = [
    { id: "claude-code", label: "Claude", full: "Claude Code" },
    { id: "codex", label: "Codex", full: "Codex" },
    { id: "antigravity", label: "Antigravity", full: "Antigravity" },
  ];

  function formatUsd(n) {
    if (!Number.isFinite(n)) return "$0";
    return n >= 100 ? "$" + Math.round(n).toLocaleString("en-US") : "$" + n.toFixed(2);
  }

  function formatTokens(n) {
    if (!Number.isFinite(n) || n <= 0) return "0 tok";
    const u = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
    for (const [s, sym] of u) {
      if (n >= s) {
        const v = n / s;
        return (v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")) + sym + " tok";
      }
    }
    return Math.round(n) + " tok";
  }

  function formatReset(iso, now) {
    if (!iso) return "";
    const ms = Date.parse(iso) - now.getTime();
    if (Number.isNaN(ms) || ms <= 0) return "";
    const mins = Math.ceil(ms / 60000);
    let cd = mins + " min";
    if (mins >= 60) {
      const h = Math.floor(mins / 60);
      const rem = mins % 60;
      cd = h < 24 ? (rem > 0 ? h + " h " + rem + " min" : h + " h") : Math.floor(h / 24) + " d";
    }
    return " (resets in " + cd + ")";
  }

  function levelClass(pct) {
    return pct >= 90 ? "usage-danger" : pct >= 75 ? "usage-warn" : "usage-ok";
  }

  function render(el, data) {
    el.textContent = "";
    if (!data || !Array.isArray(data.tools)) return;
    const now = new Date();
    const byId = new Map(data.tools.map((t) => [t.tool, t]));

    for (const { id, label, full } of TOOLS) {
      const tool = byId.get(id);
      const today = tool ? tool.today : null;
      const limits = id === "codex" ? data.codexLimits : null;
      const fiveHour = limits ? limits.fiveHour : null;
      const hasPct = Boolean(fiveHour && typeof fiveHour.usedPct === "number" && !fiveHour.stale);
      const hasTokens = Boolean(today && (today.tokens > 0 || today.replies > 0));

      let text = null;
      let cls = null;

      if (id === "claude-code") {
        if (today && typeof today.costUsd === "number" && today.costUsd > 0) {
          text = label + " " + formatUsd(today.costUsd);
        } else if (hasTokens) {
          text = label + " " + formatTokens(today.tokens);
        }
      } else if (id === "codex") {
        if (hasPct) {
          const pct = Math.round(fiveHour.usedPct);
          text = label + " " + pct + "% · 5h";
          cls = levelClass(pct);
        } else if (hasTokens) {
          text = label + " " + formatTokens(today.tokens);
        }
      } else if (id === "antigravity" && hasTokens) {
        text = label + " " + formatTokens(today.tokens);
      }

      if (!text) continue;

      const item = document.createElement("span");
      item.className = cls ? "usage-strip-item " + cls : "usage-strip-item";
      item.textContent = text;

      const lines = [full];
      if (today) {
        lines.push("Today: " + (today.tokens || 0).toLocaleString("en-US") + " tokens, " + (today.replies || 0).toLocaleString("en-US") + " replies");
        if (typeof today.costUsd === "number") lines.push("Cost: " + formatUsd(today.costUsd));
      }
      if (id === "codex" && limits) {
        if (limits.fiveHour && typeof limits.fiveHour.usedPct === "number") {
          lines.push("5-hour: " + Math.round(limits.fiveHour.usedPct) + "%" + formatReset(limits.fiveHour.resetsAt, now));
        }
        if (limits.weekly && typeof limits.weekly.usedPct === "number") {
          lines.push("Weekly: " + Math.round(limits.weekly.usedPct) + "%" + formatReset(limits.weekly.resetsAt, now));
        }
      }
      item.title = lines.join("\n");
      el.appendChild(item);
    }
  }

  function mount(el, fetchUsage) {
    if (!el) return function () {};
    const fetcher = typeof fetchUsage === "function" ? fetchUsage : function () {
      return window.terminal && typeof window.terminal.usage === "function" ? window.terminal.usage() : Promise.resolve(null);
    };

    let inFlight = false;
    let timer = null;

    async function update() {
      if (inFlight) return;
      inFlight = true;
      try {
        const data = await fetcher();
        if (data) render(el, data);
      } catch {
        // Keep last good values or show nothing on initial failure
      } finally {
        inFlight = false;
      }
    }

    function onVisibility() {
      if (document.visibilityState === "visible") void update();
    }

    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
    timer = setInterval(update, 60000);
    void update();

    function unmount() {
      if (timer) clearInterval(timer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    }
    unmount.unmount = unmount;
    return unmount;
  }

  const TerminalUsage = { mount };
  if (typeof window !== "undefined") window.TerminalUsage = TerminalUsage;
  if (typeof module !== "undefined" && module.exports) module.exports = TerminalUsage;
})();

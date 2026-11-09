(() => {
  "use strict";

  const bridge = window.terminal;
  if (!bridge) {
    document.body.className = "unsupported";
    document.body.textContent = "This window only works inside the desktop app.";
    return;
  }

  const MAX_TABS = 8;
  const tabs = [];
  let activeTab = null;
  let availableShells = [];
  let resizeTimer = null;

  const tabsListEl = document.getElementById("tabs-list");
  const newTabBtn = document.getElementById("new-tab-btn");
  const shellMenu = document.getElementById("shell-menu");
  const terminalAreaEl = document.getElementById("terminal-area");
  const quickLaunchBtns = document.querySelectorAll(".quick-launch-btn");

  function updateQuickLaunch() {
    const canLaunch = Boolean(activeTab && activeTab.running && activeTab.sessionId);
    for (const btn of quickLaunchBtns) btn.disabled = !canLaunch;
  }

  function updateTabControls() {
    const atMax = tabs.length >= MAX_TABS;
    newTabBtn.disabled = atMax;
    newTabBtn.title = atMax ? "Up to 8 terminals" : "New terminal";
    if (atMax) hideShellMenu();
  }

  function hideShellMenu() {
    shellMenu.classList.add("hidden");
  }

  function toggleShellMenu() {
    if (tabs.length >= MAX_TABS) return;
    if (availableShells.length === 0) {
      createTab();
      return;
    }
    shellMenu.classList.toggle("hidden");
  }

  function renderShellMenu() {
    shellMenu.replaceChildren();
    for (const shell of availableShells) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "shell-menu-item";
      item.textContent = shell.label || shell.id;
      item.addEventListener("click", () => {
        hideShellMenu();
        if (tabs.length < MAX_TABS) createTab(shell.id);
      });
      shellMenu.appendChild(item);
    }
  }

  function refitTab(tab) {
    if (!tab || !tab.fitAddon || !tab.term) return;
    try { tab.fitAddon.fit(); } catch { return; }
    const cols = tab.term.cols;
    const rows = tab.term.rows;
    if (tab.sessionId && tab.running && (cols !== tab.cols || rows !== tab.rows)) {
      tab.cols = cols;
      tab.rows = rows;
      bridge.resize(tab.sessionId, cols, rows).catch(() => {});
    }
  }

  function activateTab(tab) {
    if (activeTab && activeTab !== tab) {
      activeTab.tabEl.classList.remove("active");
      activeTab.paneEl.classList.remove("active");
    }
    activeTab = tab;
    tab.tabEl.classList.add("active");
    tab.paneEl.classList.add("active");
    refitTab(tab);
    if (tab.term) tab.term.focus();
    updateQuickLaunch();
  }

  function closeTab(tab) {
    const idx = tabs.indexOf(tab);
    if (idx === -1) return;

    if (tab.running && tab.sessionId) bridge.kill(tab.sessionId).catch(() => {});
    tab.running = false;

    if (tab.term) {
      try { tab.term.dispose(); } catch {}
    }

    tab.tabEl.remove();
    tab.paneEl.remove();
    tabs.splice(idx, 1);

    if (activeTab === tab) {
      if (tabs.length > 0) {
        activateTab(tabs[Math.min(idx, tabs.length - 1)]);
      } else {
        activeTab = null;
      }
    }

    if (tabs.length === 0) {
      createTab(availableShells[0]?.id);
    } else {
      updateTabControls();
      updateQuickLaunch();
    }
  }

  function handleShortcut(event, fromTerminal) {
    const isCtrl = event.ctrlKey || event.metaKey;
    if (!isCtrl) return false;

    if (event.shiftKey && !event.altKey && (event.key === "T" || event.key === "t" || event.code === "KeyT")) {
      event.preventDefault();
      if (tabs.length < MAX_TABS) createTab(availableShells[0]?.id);
      return true;
    }
    if (event.shiftKey && !event.altKey && (event.key === "W" || event.key === "w" || event.code === "KeyW")) {
      event.preventDefault();
      if (activeTab) closeTab(activeTab);
      return true;
    }
    if (!event.altKey && event.key === "Tab") {
      event.preventDefault();
      if (tabs.length > 1) {
        const idx = tabs.indexOf(activeTab);
        const delta = event.shiftKey ? -1 : 1;
        activateTab(tabs[(idx + delta + tabs.length) % tabs.length]);
      }
      return true;
    }
    if (fromTerminal && !event.shiftKey && !event.altKey && (event.key === "c" || event.key === "C" || event.code === "KeyC")) {
      if (activeTab && activeTab.term && activeTab.term.hasSelection()) {
        event.preventDefault();
        const sel = activeTab.term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return true;
      }
      return false;
    }
    if (fromTerminal && !event.shiftKey && !event.altKey && (event.key === "v" || event.key === "V" || event.code === "KeyV")) {
      event.preventDefault();
      navigator.clipboard.readText().then((text) => {
        if (text && activeTab && activeTab.running && activeTab.sessionId) {
          bridge.write(activeTab.sessionId, text);
        }
      }).catch(() => {});
      return true;
    }
    return false;
  }

  function createTabRecord(title) {
    const tabEl = document.createElement("div");
    tabEl.className = "tab-item";
    tabEl.setAttribute("role", "tab");

    const titleEl = document.createElement("span");
    titleEl.className = "tab-title";
    titleEl.textContent = title;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "tab-close-btn";
    closeBtn.textContent = "×";
    closeBtn.title = "Close tab";
    closeBtn.setAttribute("aria-label", "Close");
    tabEl.append(titleEl, closeBtn);

    const paneEl = document.createElement("div");
    paneEl.className = "terminal-pane";

    const term = new window.Terminal({
      cursorBlink: true,
      fontFamily: "Cascadia Mono, Consolas, Menlo, monospace",
      fontSize: 13,
      theme: { background: "#08090b" },
      scrollback: 5000,
    });
    const fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    const tab = {
      sessionId: null,
      title,
      term,
      fitAddon,
      tabEl,
      titleEl,
      paneEl,
      running: true,
      cols: 0,
      rows: 0,
    };

    tabEl.addEventListener("click", (e) => {
      if (e.target === closeBtn) {
        e.stopPropagation();
        closeTab(tab);
      } else {
        activateTab(tab);
      }
    });

    term.attachCustomKeyEventHandler((e) => (e.type === "keydown" ? !handleShortcut(e, true) : true));
    term.onData((d) => {
      if (tab.running && tab.sessionId) bridge.write(tab.sessionId, d);
    });

    tabs.push(tab);
    tabsListEl.appendChild(tabEl);
    terminalAreaEl.appendChild(paneEl);
    activateTab(tab);

    term.open(paneEl);
    fitAddon.fit();
    tab.cols = term.cols || 80;
    tab.rows = term.rows || 24;

    updateTabControls();
    return tab;
  }

  async function createTab(shellId) {
    if (tabs.length >= MAX_TABS) return;
    const tab = createTabRecord("Terminal");

    let res;
    try {
      res = await bridge.create({ shellId, cols: tab.cols, rows: tab.rows });
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (!tabs.includes(tab)) {
      if (res && res.ok && res.id) bridge.kill(res.id).catch(() => {});
      return;
    }

    if (!res || !res.ok) {
      tab.running = false;
      if (tab.term) {
        try { tab.term.dispose(); } catch {}
        tab.term = null;
        tab.fitAddon = null;
      }
      const errEl = document.createElement("div");
      errEl.className = "terminal-error";
      errEl.textContent = res && res.error ? res.error : "Failed to create terminal session";
      tab.paneEl.replaceChildren(errEl);
      updateQuickLaunch();
      return;
    }

    tab.sessionId = res.id;
    tab.title = res.title || "Terminal";
    tab.titleEl.textContent = tab.title;
    tab.term.focus();
    updateQuickLaunch();
  }

  function openExistingSession(sessionId, title) {
    if (tabs.length >= MAX_TABS) return;
    const tab = createTabRecord(title || "Terminal");
    tab.sessionId = sessionId;
    tab.title = title || "Terminal";
    tab.titleEl.textContent = tab.title;
    bridge.resize(sessionId, tab.cols, tab.rows).catch(() => {});
    tab.term.focus();
    updateQuickLaunch();
  }

  bridge.onData((id, data) => {
    const tab = tabs.find((t) => t.sessionId === id);
    if (tab && tab.term) tab.term.write(data);
  });

  bridge.onExit((id, exitCode) => {
    const tab = tabs.find((t) => t.sessionId === id);
    if (!tab) return;
    tab.running = false;
    tab.titleEl.textContent = `${tab.title} (exited)`;
    if (tab.term) {
      tab.term.write(`\r\n\x1b[2m[process exited with code ${exitCode}]\x1b[0m\r\n`);
    }
    updateQuickLaunch();
  });

  bridge.onOpened(({ id, title }) => openExistingSession(id, title));

  const resizeObserver = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (activeTab) refitTab(activeTab);
    }, 50);
  });
  resizeObserver.observe(terminalAreaEl);

  newTabBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleShellMenu();
  });

  document.addEventListener("click", (e) => {
    if (!shellMenu.contains(e.target) && e.target !== newTabBtn) hideShellMenu();
  });

  for (const btn of quickLaunchBtns) {
    btn.addEventListener("click", () => {
      if (!activeTab || !activeTab.running || !activeTab.sessionId) return;
      const tool = btn.getAttribute("data-tool");
      bridge.launch(activeTab.sessionId, tool).then(() => {
        if (activeTab && activeTab.term) activeTab.term.focus();
      }).catch(() => {});
    });
  }

  window.addEventListener("keydown", (event) => {
    handleShortcut(event, false);
  });

  async function init() {
    try {
      const shells = await bridge.shells();
      availableShells = Array.isArray(shells) ? shells : [];
    } catch {
      availableShells = [];
    }
    renderShellMenu();
    await createTab(availableShells[0]?.id);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

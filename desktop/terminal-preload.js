/**
 * Preload bridge for the terminal window only.
 *
 * The dashboard window never loads this file, so it cannot reach a shell.
 * Everything the page sends is validated here and again in the main process;
 * the page never names a program, a path or an argument. It picks a shell id
 * from the list main offers, and a quick-launch tool from a fixed set of three.
 */
const { contextBridge, ipcRenderer } = require("electron");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHELL_ID = /^[a-z-]{1,32}$/;
const TOOLS = ["claude", "agy", "codex"];
const MAX_WRITE_BYTES = 64 * 1024;

const isId = (v) => typeof v === "string" && UUID.test(v);
const isInt = (v, min, max) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** Subscribes to a main-process channel; returns an unsubscribe function. */
function listen(channel, pick, callback) {
  if (typeof callback !== "function") return () => {};
  const handler = (_event, payload) => {
    const args = pick(payload);
    if (args) callback(...args);
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

contextBridge.exposeInMainWorld("terminal", {
  /** Shells this machine offers, as `{ id, label }`. */
  shells() {
    return ipcRenderer.invoke("terminal:shells");
  },

  /** Starts a shell in the user's home folder. */
  async create(options) {
    const shellId = options?.shellId;
    const cols = options?.cols;
    const rows = options?.rows;
    if (shellId !== undefined && shellId !== null && (typeof shellId !== "string" || !SHELL_ID.test(shellId))) {
      return { ok: false, error: "Unknown shell." };
    }
    if (!isInt(cols, 2, 500) || !isInt(rows, 1, 300)) {
      return { ok: false, error: "The terminal size is not valid." };
    }
    return ipcRenderer.invoke("terminal:create", { shellId: shellId ?? undefined, cols, rows });
  },

  write(id, data) {
    if (!isId(id) || typeof data !== "string" || new TextEncoder().encode(data).length > MAX_WRITE_BYTES) return;
    ipcRenderer.send("terminal:write", id, data);
  },

  async resize(id, cols, rows) {
    if (!isId(id) || !isInt(cols, 2, 500) || !isInt(rows, 1, 300)) return;
    await ipcRenderer.invoke("terminal:resize", id, cols, rows);
  },

  async kill(id) {
    if (!isId(id)) return;
    await ipcRenderer.invoke("terminal:kill", id);
  },

  /** Types one of the three known tool names into a session. */
  async launch(id, tool) {
    if (!isId(id) || !TOOLS.includes(tool)) return false;
    return ipcRenderer.invoke("terminal:launch", id, tool);
  },

  /** Today's usage, or null when unavailable. */
  usage() {
    return ipcRenderer.invoke("terminal:usage");
  },

  /**
   * Sessions main opened for this window before the page was ready (a project's
   * "Terminal in app" button). Also tells main the page can take live events.
   */
  initial() {
    return ipcRenderer.invoke("terminal:initial");
  },

  onData(callback) {
    return listen("terminal:data", (p) => (Array.isArray(p) && isId(p[0]) && typeof p[1] === "string" ? [p[0], p[1]] : null), callback);
  },

  onExit(callback) {
    return listen("terminal:exit", (p) => (Array.isArray(p) && isId(p[0]) && Number.isInteger(p[1]) ? [p[0], p[1]] : null), callback);
  },

  onOpened(callback) {
    return listen(
      "terminal:opened",
      (p) => (p && isId(p.id) && typeof p.title === "string" ? [{ id: p.id, title: p.title.slice(0, 200), cwd: typeof p.cwd === "string" ? p.cwd : "" }] : null),
      callback,
    );
  },
});

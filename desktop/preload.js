/**
 * Preload bridge.
 *
 * Runs with context isolation and no Node integration. The renderer is a normal
 * web page and must not gain filesystem or process access just because it
 * happens to be running inside Electron, so what is exposed here is deliberately
 * narrow: menu navigation, and a request to open one project's local folder.
 *
 * Note what `openLocal` does *not* take: a path. It takes a project id and the
 * name of an action, and the main process looks the path up from the project the
 * server already holds. There is no argument a page could supply that would make
 * this open somewhere else.
 */
const { contextBridge, ipcRenderer } = require("electron");

/**
 * Whether a value is an in-app route and nothing more.
 *
 * A bare `startsWith("/")` is not enough: "//example.com/x" also starts with a
 * slash and is a protocol-relative URL, so a router would navigate off-origin.
 * Requiring a second character that is not a slash or backslash keeps this to
 * real paths. Backslash is included because browsers normalise it to a slash.
 */
function isSafeRoute(route) {
  return (
    typeof route === "string" &&
    route.startsWith("/") &&
    !route.startsWith("//") &&
    !route.startsWith("/\\")
  );
}

/** The only actions the renderer may ask for. */
const ACTIONS = ["folder", "reveal", "editor", "terminal"];

contextBridge.exposeInMainWorld("desktop", {
  /** True only inside the desktop shell, so the web build can branch on it. */
  isDesktop: true,
  platform: process.platform,

  /**
   * Subscribes to menu navigation. Returns an unsubscribe function.
   * The route is produced by the main process menu, never by page content.
   */
  onNavigate(callback) {
    const handler = (_event, route) => {
      if (isSafeRoute(route)) callback(route);
    };
    ipcRenderer.on("desktop:navigate", handler);
    return () => ipcRenderer.off("desktop:navigate", handler);
  },

  /**
   * Opens a project's local folder, editor or terminal.
   *
   * Resolves to `{ ok: true }` or `{ ok: false, error }` — a missing folder or
   * an editor that is not installed is an ordinary outcome to show the user,
   * not an exception. Validated here as well as in the main process: the
   * renderer is the least trusted side, so it should not be able to send a
   * malformed message at all.
   */
  async openLocal(projectId, action) {
    if (typeof projectId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) {
      return { ok: false, error: "Unknown project." };
    }
    if (!ACTIONS.includes(action)) {
      return { ok: false, error: "Unsupported action." };
    }
    return ipcRenderer.invoke("desktop:open-local", { projectId, action });
  },
});

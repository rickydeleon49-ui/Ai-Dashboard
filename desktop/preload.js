/**
 * Preload bridge.
 *
 * Runs with context isolation and no Node integration. It exposes exactly one
 * capability — letting the menu drive client-side navigation — and nothing else.
 * The renderer is a normal web page; it must not gain filesystem or process
 * access just because it happens to be running inside Electron.
 */
const { contextBridge, ipcRenderer } = require("electron");

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
      if (typeof route === "string" && route.startsWith("/")) callback(route);
    };
    ipcRenderer.on("desktop:navigate", handler);
    return () => ipcRenderer.off("desktop:navigate", handler);
  },
});

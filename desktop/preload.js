/**
 * Preload bridge.
 *
 * Runs with context isolation and no Node integration. It exposes exactly one
 * capability — letting the menu drive client-side navigation — and nothing else.
 * The renderer is a normal web page; it must not gain filesystem or process
 * access just because it happens to be running inside Electron.
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
});

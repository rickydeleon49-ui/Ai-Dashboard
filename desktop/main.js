/**
 * Electron main process.
 *
 * The dashboard is a full Next.js application — Server Components query SQLite
 * directly — so the desktop build does not reimplement anything. It starts the
 * same Next server on a private localhost port and points a window at it.
 *
 * Two things make it behave like an application rather than a wrapped web page:
 *   1. Storage lives in the OS user-data directory, not the working directory.
 *   2. Outbound links (Open GitHub, Open Project) go to the real browser.
 */
const electron = require("electron");
const { app, BrowserWindow, Menu, shell, dialog, ipcMain, safeStorage, session } =
  typeof electron === "object" && electron !== null ? electron : {};
const { fork, spawn } = require("node:child_process");
const { editorCandidates, terminalCandidates, launchFirst } = require("./launch");
const { createOllamaSupervisor } = require("./ollama");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

// Cryptographically random secret generated once per application launch
let desktopSecret = crypto.randomBytes(32).toString("hex");

/*
 * Development attaches to `next dev`; a packaged app starts the bundled server.
 *
 * `app.isPackaged` is false for anything run from a checkout, tests included,
 * so DESKTOP_BUNDLED forces the path packaging actually ships. Without it a
 * test of the desktop shell would silently exercise the dev path instead and
 * then block on an error dialog when no dev server answers.
 */
const isDev = process.env.DESKTOP_BUNDLED === "1" ? false : !(app && app.isPackaged);

/**
 * Where the packaged Next standalone server lives.
 *
 * Packaging runs with asar disabled so that `fork()` and the native
 * better-sqlite3 binary both see real files on disk — neither works from inside
 * an asar archive. The binary itself is Node-API, so the same file is valid
 * under plain Node and under Electron with no rebuild step.
 */
function serverRoot() {
  return path.join(app.getAppPath(), ".next", "standalone");
}

let mainWindow = null;
let serverProcess = null;
let baseUrl = "http://localhost:3000";

/** Set once the user is quitting, so a dying server is not treated as a crash. */
let quitting = false;
/** Environment for the bundled server, kept so it can be restarted. */
let serverEnv = null;
let restartAttempts = 0;
const MAX_RESTART_ATTEMPTS = 3;

/** The Ollama supervisor, created once the server can tell us its endpoint. */
let ollama = null;
/** Last known local AI state, so the renderer can ask without re-probing. */
let ollamaState = { state: "unknown", owned: false, error: null };

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Point the database and uploads at the per-user application data directory.
 *
 * `src/db/path.ts` already reads these variables (they exist so a Railway volume
 * can be used in production), so the desktop build needs no code changes — it
 * just sets them before the server starts.
 *
 *   macOS   ~/Library/Application Support/Command Center
 *   Windows %APPDATA%\Command Center
 *   Linux   ~/.config/Command Center
 */
function resolveUserPaths() {
  const userData = app.getPath("userData");
  const dataDir = path.join(userData, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  return {
    userData,
    DATABASE_PATH: path.join(dataDir, "dashboard.db"),
    UPLOADS_DIR: path.join(dataDir, "uploads"),
  };
}

/**
 * The symmetric key `src/core/settings/service.ts` uses to encrypt secrets
 * (currently just the GitHub token) before they reach SQLite.
 *
 * `safeStorage` only exists in this process — the forked server runs with
 * `ELECTRON_RUN_AS_NODE=1`, plain Node, no Electron API. Rather than round-
 * tripping every encrypt/decrypt over IPC to here, `safeStorage` is used just
 * once, to protect this one small key, which then travels to the server as
 * an env var the same way DATABASE_PATH does; the server does its own AES
 * work with it. That keeps `getSetting`/`setSetting` synchronous.
 *
 * Returns null when there is nothing to protect the key with (no OS keyring
 * available), in which case the caller stores secrets as plaintext — the same
 * behaviour this app always had, not a regression.
 */
function resolveEncryptionKey() {
  if (!safeStorage.isEncryptionAvailable()) return null;

  const file = path.join(app.getPath("userData"), "settings-key.enc");
  try {
    return safeStorage.decryptString(fs.readFileSync(file));
  } catch {
    // No key yet, or the file is unreadable — generate a fresh one below.
  }

  const key = crypto.randomBytes(32).toString("base64");
  try {
    fs.writeFileSync(file, safeStorage.encryptString(key));
  } catch (error) {
    console.error(`[secrets] could not persist the encryption key: ${error.message}`);
    return null;
  }
  return key;
}

// ---------------------------------------------------------------------------
// Window state
// ---------------------------------------------------------------------------

/** Remembering size and position is table stakes for a desktop app. */
function windowStateFile() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function loadWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(windowStateFile(), "utf8"));
    if (typeof state.width === "number" && typeof state.height === "number") {
      return state;
    }
  } catch {
    // No saved state, or it is unreadable — fall through to defaults.
  }
  return { width: 1440, height: 940 };
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(
      windowStateFile(),
      JSON.stringify({ ...bounds, maximized: win.isMaximized() }),
    );
  } catch {
    // Losing window position is not worth surfacing to the user.
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** Asks the OS for an unused port so two copies never collide. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = net.connect({ host: "127.0.0.1", port: Number(new URL(url).port) });
      request.on("connect", () => {
        request.end();
        resolve();
      });
      request.on("error", () => {
        request.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Server did not start within ${timeoutMs / 1000}s`));
        } else {
          setTimeout(attempt, 150);
        }
      });
    };
    attempt();
  });
}

/**
 * Starts the bundled Next standalone server as a child process.
 *
 * ELECTRON_RUN_AS_NODE makes Electron's own binary behave as plain Node, so the
 * packaged app carries no separate Node runtime. Running the server out of
 * process also means a server crash cannot take the window down with it.
 */
async function startServer(env) {
  serverEnv = env;
  const port = await findFreePort();
  const root = serverRoot();
  const serverEntry = path.join(root, "server.js");

  if (!fs.existsSync(serverEntry)) {
    throw new Error(
      `Bundled server not found at ${serverEntry}. Run \`npm run desktop:build\` first.`,
    );
  }

  serverProcess = fork(serverEntry, [], {
    cwd: root,
    env: {
      ...process.env,
      ...env,
      NODE_ENV: "production",
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      // Tells the server it is running locally, so it does not demand the
      // password a public deployment requires. Safe because the server binds
      // 127.0.0.1 on a random port and nothing off this machine can reach it.
      DASHBOARD_LOCAL: "1",
      DESKTOP_INTERNAL_SECRET: desktopSecret,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  serverProcess.stdout?.on("data", (d) => console.log(`[next] ${d}`.trimEnd()));
  serverProcess.stderr?.on("data", (d) => console.error(`[next] ${d}`.trimEnd()));

  // The window is only a view onto this process. If it dies the app is not
  // closed — it is showing a page that will never load again — so recover
  // rather than leaving a window that looks broken with no explanation.
  serverProcess.on("exit", (code, signal) => {
    if (quitting) return;
    console.error(`[next] server exited unexpectedly (code=${code} signal=${signal})`);
    void recoverFromServerCrash();
  });

  const url = `http://127.0.0.1:${port}`;
  await waitForServer(url);
  return url;
}

/**
 * Restarts the bundled server after an unexpected exit and reloads the window.
 *
 * Bounded: a server that cannot stay up would otherwise restart forever behind a
 * blank window. After the limit the user is told what happened instead.
 */
async function recoverFromServerCrash() {
  serverProcess = null;

  if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
    dialog.showErrorBox(
      "Command Center stopped responding",
      "Its background service exited repeatedly and could not be restarted.\n\n" +
        "Reopening the application usually clears this. If it keeps happening, " +
        "the log from a terminal launch will show why the service is failing.",
    );
    app.quit();
    return;
  }

  restartAttempts += 1;

  try {
    baseUrl = await startServer(serverEnv ?? {});
    setupDesktopHeaderInjection(baseUrl);
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(baseUrl);
    }
    // A restart that survives long enough to serve the window is treated as a
    // recovery, so an unrelated crash weeks later gets a full set of retries.
    setTimeout(() => {
      restartAttempts = 0;
    }, 60_000);
  } catch (error) {
    dialog.showErrorBox(
      "Command Center could not restart its background service",
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  }
}

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    serverProcess = null;
  }
}

// ---------------------------------------------------------------------------
// Window & Header Injection
// ---------------------------------------------------------------------------

let currentServerOrigin = null;

function setupDesktopHeaderInjection(serverUrl) {
  try {
    const serverOrigin = new URL(serverUrl).origin;
    currentServerOrigin = serverOrigin;

    if (session?.defaultSession?.webRequest) {
      session.defaultSession.webRequest.onBeforeSendHeaders(
        { urls: [`${serverOrigin}/*`] },
        (details, callback) => {
          try {
            const reqOrigin = new URL(details.url).origin;
            if (reqOrigin === currentServerOrigin && desktopSecret) {
              details.requestHeaders["x-dashboard-desktop-secret"] = desktopSecret;
            }
          } catch {
            // ignore malformed URLs
          }
          callback({ requestHeaders: details.requestHeaders });
        },
      );
    }
  } catch (error) {
    console.error("[desktop] Failed to setup header injection:", error);
  }
}

/**
 * Strictly validates that a path or URL points to the local bundled server.
 *
 * Rules:
 * 1. Must be a string.
 * 2. Rejects protocol-relative URLs (e.g. "//evil.com", "/\\evil.com", "\\evil.com").
 * 3. Relative paths (starting with "/" and not "//") are resolved against baseUrl.
 * 4. Absolute URLs are parsed with `new URL()`.
 *    - Scheme must match baseUrl's scheme (typically "http:").
 *    - Hostname must match baseUrl's hostname (e.g. "127.0.0.1" or "localhost").
 *    - Port must match baseUrl's port.
 *    - Must NOT have credentials (username or password).
 * 5. Anything failing this check throws an Error before any network I/O.
 */
function validateAndResolveInternalUrl(pathOrUrl, currentBaseUrl = baseUrl) {
  if (typeof pathOrUrl !== "string") {
    throw new TypeError("Invalid request URL: path must be a string");
  }

  // Reject protocol-relative URLs or backslash bypasses
  if (
    pathOrUrl.startsWith("//") ||
    pathOrUrl.startsWith("/\\") ||
    pathOrUrl.startsWith("\\\\") ||
    pathOrUrl.startsWith("\\/")
  ) {
    throw new Error(`Refusing internal fetch with protocol-relative URL: ${pathOrUrl}`);
  }

  let serverUrl;
  try {
    serverUrl = new URL(currentBaseUrl);
  } catch {
    throw new Error(`Invalid base server URL: ${currentBaseUrl}`);
  }

  let targetUrl;

  // Relative path (preferred)
  if (pathOrUrl.startsWith("/")) {
    try {
      targetUrl = new URL(pathOrUrl, serverUrl);
    } catch {
      throw new Error(`Malformed relative path: ${pathOrUrl}`);
    }
  } else {
    // Must be an absolute URL
    try {
      targetUrl = new URL(pathOrUrl);
    } catch {
      throw new Error(`Malformed or non-relative request URL: ${pathOrUrl}`);
    }
  }

  // Reject credential-bearing URLs (e.g. http://user:pass@127.0.0.1:3000)
  if (targetUrl.username || targetUrl.password) {
    throw new Error(`Refusing internal fetch with credentials in URL: ${pathOrUrl}`);
  }

  // Exact origin match: scheme, hostname, and port
  if (targetUrl.protocol !== serverUrl.protocol) {
    throw new Error(
      `Refusing internal fetch to non-same-origin scheme (${targetUrl.protocol} !== ${serverUrl.protocol}): ${pathOrUrl}`
    );
  }

  if (targetUrl.hostname !== serverUrl.hostname) {
    throw new Error(
      `Refusing internal fetch to non-same-origin host (${targetUrl.hostname} !== ${serverUrl.hostname}): ${pathOrUrl}`
    );
  }

  if (targetUrl.port !== serverUrl.port) {
    throw new Error(
      `Refusing internal fetch to non-same-origin port (${targetUrl.port} !== ${serverUrl.port}): ${pathOrUrl}`
    );
  }

  return targetUrl.href;
}

/**
 * Private main-process fetch helper for requests sent to the bundled server.
 * Node's global `fetch` does not pass through Chromium's `session.webRequest`,
 * so this helper validates exact origin match and injects the launch secret into headers.
 * The secret is never exposed to renderer JavaScript, HTML, URLs, logs, or IPC.
 */
async function internalFetch(pathOrUrl, options = {}) {
  const resolvedUrl = validateAndResolveInternalUrl(pathOrUrl);

  const headers = new Headers(options.headers || {});
  if (desktopSecret) {
    headers.set("x-dashboard-desktop-secret", desktopSecret);
  }

  return fetch(resolvedUrl, {
    ...options,
    headers,
  });
}

const isTestEnv =
  process.env.NODE_ENV === "test" ||
  process.env.DESKTOP_TEST_MODE === "1" ||
  Boolean(process.env.TEST);

if (typeof app !== "undefined" && app && isTestEnv && !app.isPackaged) {
  app.internalFetchForTesting = internalFetch;
}

function createWindow() {
  if (baseUrl) {
    setupDesktopHeaderInjection(baseUrl);
  }
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 720,
    minHeight: 560,
    // Matches the app's dark canvas so there is no white flash while loading.
    backgroundColor: "#08090b",
    show: false,
    title: "Command Center",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (state.maximized) mainWindow.maximize();

  mainWindow.once("ready-to-show", () => mainWindow.show());

  // Persist geometry, throttled so a drag does not write on every frame.
  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(mainWindow), 400);
  };
  mainWindow.on("resize", scheduleSave);
  mainWindow.on("move", scheduleSave);
  mainWindow.on("close", () => saveWindowState(mainWindow));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // "Open GitHub", "Open Project" and every other outbound link belongs in the
  // user's real browser, with their sessions and extensions — not in a bare
  // Electron window with no chrome.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // Same for a plain in-window navigation to an external origin.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isInternalUrl(url)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.loadURL(baseUrl);
}

/**
 * Whether a URL belongs to the bundled server.
 *
 * Compared by parsed origin, not by string prefix. `url.startsWith(baseUrl)`
 * looks equivalent and is not: with baseUrl "http://127.0.0.1:41234", the URL
 * "http://127.0.0.1:41234@example.com/" starts with it while actually pointing
 * at example.com — everything before the "@" is credentials. Parsing decides on
 * the real origin instead of on how the string happens to begin.
 */
function isInternalUrl(url) {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    // Unparseable is not internal.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

/** Sends the renderer to a route without a full page reload. */
function go(route) {
  mainWindow?.webContents.send("desktop:navigate", route);
}

function buildMenu() {
  const isMac = process.platform === "darwin";

  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Project",
          accelerator: "CmdOrCtrl+N",
          click: () => go("/projects/new"),
        },
        { type: "separator" },
        {
          label: "Open Data Folder",
          click: () => shell.openPath(path.join(app.getPath("userData"), "data")),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "Go",
      submenu: [
        { label: "Dashboard", accelerator: "CmdOrCtrl+1", click: () => go("/") },
        { label: "All Projects", accelerator: "CmdOrCtrl+2", click: () => go("/projects") },
        { label: "GitHub", accelerator: "CmdOrCtrl+3", click: () => go("/github") },
        { label: "Favorites", accelerator: "CmdOrCtrl+4", click: () => go("/favorites") },
        { label: "Local AI", accelerator: "CmdOrCtrl+5", click: () => go("/ai/chat") },
        { type: "separator" },
        { label: "Settings", accelerator: "CmdOrCtrl+,", click: () => go("/settings") },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Project Repository",
          click: () =>
            shell.openExternal("https://github.com/rickydeleon49-ui/Ai-Dashboard"),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}


// ---------------------------------------------------------------------------
// Local AI
// ---------------------------------------------------------------------------

/**
 * Bringing the local AI service up with the application.
 *
 * The shell holds no settings of its own — it asks the bundled server, which
 * owns the database, what the user configured. That keeps one copy of every
 * preference and means a change in Settings takes effect on the next launch
 * with no second place to update.
 *
 * Ollama is *started*, never *loaded*: bringing the API up costs nothing, while
 * pulling a model into VRAM costs gigabytes. The model waits for the first
 * message unless preloading was explicitly asked for.
 */
async function startupConfig() {
  const response = await internalFetch("/api/ai/startup");
  if (!response.ok) throw new Error(`startup config returned ${response.status}`);
  return response.json();
}

async function initialiseLocalAi() {
  let config;
  try {
    config = await startupConfig();
  } catch (error) {
    console.error(`[ai] could not read local AI settings: ${error.message}`);
    return;
  }

  if (!config.enabled) {
    ollamaState = { state: "disabled", owned: false, error: null };
    return;
  }

  ollama = createOllamaSupervisor({
    endpoint: config.endpoint,
    logger: (fields) => console.log(JSON.stringify({ scope: "ai", ...fields })),
  });

  if (!config.autoStart) {
    const healthy = await ollama.probe();
    ollamaState = { state: healthy ? "running" : "offline", owned: false, error: null };
    return;
  }

  ollamaState = await ollama.ensureRunning();

  // Preloading is a separate, opt-in step and never blocks the window: the user
  // can be typing in the workspace while the weights are still being read.
  if (config.preloadModel && config.model && ollamaState.state !== "failed") {
    internalFetch("/api/ai/preload", { method: "POST" }).catch((error) =>
      console.error(`[ai] preload failed: ${error.message}`),
    );
  }
}

function registerLocalAi() {
  ipcMain.handle("desktop:ai-status", async () => {
    if (!ollama) return { ...ollamaState, reachable: false };
    return { ...ollamaState, reachable: await ollama.probe() };
  });

  // Takes no arguments at all. There is nothing the renderer could pass that
  // would change what gets executed.
  ipcMain.handle("desktop:ai-start", async () => {
    if (!ollama) {
      try {
        const config = await startupConfig();
        if (!config.enabled) return { ok: false, error: "Local AI is turned off in Settings." };
        ollama = createOllamaSupervisor({
          endpoint: config.endpoint,
          logger: (fields) => console.log(JSON.stringify({ scope: "ai", ...fields })),
        });
      } catch {
        return { ok: false, error: "Could not read the local AI settings." };
      }
    }

    ollamaState = await ollama.ensureRunning();
    if (ollamaState.state === "failed") {
      return {
        ok: false,
        error:
          "Ollama could not be started. Check that it is installed and can run from a terminal.",
        detail: ollamaState.error,
      };
    }
    return { ok: true, state: ollamaState.state, owned: ollamaState.owned };
  });
}

// ---------------------------------------------------------------------------
// Local project actions
// ---------------------------------------------------------------------------

/**
 * Opening a project's folder, editor or terminal.
 *
 * This is the one place the application reaches outside itself, so the rules
 * are strict:
 *
 *   The renderer never supplies a path. It sends a project id and the name of
 *   an action; the path is looked up here, from the project the bundled server
 *   already holds. A compromised or buggy page therefore cannot ask for an
 *   arbitrary location — only for a project that exists.
 *
 *   Nothing is passed through a shell. Every launch uses an argv array, and the
 *   directory is handed over as the child's working directory rather than
 *   interpolated into a command string, so a path containing quotes, spaces or
 *   semicolons is data and never syntax.
 */

const ACTIONS = new Set(["folder", "reveal", "editor", "terminal"]);

/** Asks the bundled server for a project. Returns null when there is none. */
async function fetchProject(id) {
  const response = await internalFetch(`/api/projects/${encodeURIComponent(id)}`);
  if (!response.ok) return null;
  const body = await response.json();
  return body.project ?? null;
}

/** Expands a leading ~ and resolves to an absolute path. */
function resolveLocalPath(localPath) {
  const expanded = localPath.startsWith("~")
    ? path.join(os.homedir(), localPath.slice(1))
    : localPath;
  return path.resolve(expanded);
}

function registerLocalActions() {
  ipcMain.handle("desktop:open-local", async (_event, payload) => {
    const id = payload?.projectId;
    const action = payload?.action;

    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      return { ok: false, error: "Unknown project." };
    }
    if (!ACTIONS.has(action)) {
      return { ok: false, error: "Unsupported action." };
    }

    let project;
    try {
      project = await fetchProject(id);
    } catch {
      return { ok: false, error: "Could not reach the dashboard server." };
    }
    if (!project) return { ok: false, error: "Unknown project." };

    if (!project.localPath) {
      return { ok: false, error: "This project has no local folder set." };
    }

    const target = resolveLocalPath(project.localPath);
    if (!fs.existsSync(target)) {
      return { ok: false, error: `That folder no longer exists:\n${target}` };
    }

    if (action === "folder") {
      // Returns an empty string on success, or a message describing why not.
      const failure = await shell.openPath(target);
      return failure ? { ok: false, error: failure } : { ok: true };
    }

    if (action === "reveal") {
      shell.showItemInFolder(target);
      return { ok: true };
    }

    const isDirectory = fs.statSync(target).isDirectory();
    const cwd = isDirectory ? target : path.dirname(target);

    if (action === "editor") {
      const editors = editorCandidates();
      // The directory is an argument here, not the cwd: an editor opens what it
      // is given, and passing "." would depend on how it resolves relative paths.
      const launched = await launchFirst(
        editors.map((command) => ({ command, args: [target] })),
        cwd,
        spawn,
      );
      return launched
        ? { ok: true }
        : { ok: false, error: "No supported editor was found on this machine." };
    }

    const terminals = terminalCandidates();
    const launched = await launchFirst(terminals, cwd, spawn);
    return launched
      ? { ok: true }
      : { ok: false, error: "No terminal application was found on this machine." };
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (app) {
  app.setName("Command Center");

  // A second launch should focus the existing window, not open a second database.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on("second-instance", () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });

    app.whenReady().then(async () => {
      const paths = resolveUserPaths();

      try {
        if (isDev) {
          // Development attaches to `next dev`, so edits hot-reload as usual.
          baseUrl = process.env.DESKTOP_DEV_URL ?? "http://localhost:3000";
          await waitForServer(baseUrl, 60_000);
        } else {
          const encryptionKey = resolveEncryptionKey();
          baseUrl = await startServer({
            DATABASE_PATH: paths.DATABASE_PATH,
            UPLOADS_DIR: paths.UPLOADS_DIR,
            ...(encryptionKey ? { SETTINGS_ENCRYPTION_KEY: encryptionKey } : {}),
          });
        }
      } catch (error) {
        dialog.showErrorBox(
          "Command Center could not start",
          `${error.message}\n\n${
            isDev
              ? "In development, run `npm run dev` first — the desktop shell attaches to it."
              : ""
          }`,
        );
        app.quit();
        return;
      }

      buildMenu();
      registerLocalActions();
      registerLocalAi();
      createWindow();

      // After the window, not before: the AI service coming up is not something
      // the user should wait behind a blank screen for.
      void initialiseLocalAi();

      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    });

    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") app.quit();
    });

    app.on("before-quit", () => {
      quitting = true;
      stopServer();
      // Only ever stops an instance this application started. An Ollama that was
      // already running when Command Center opened is left alone.
      ollama?.stopIfOwned();
    });
    app.on("will-quit", () => {
      quitting = true;
      stopServer();
      ollama?.stopIfOwned();
    });
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    validateInternalUrlForTesting: validateAndResolveInternalUrl,
    recoverFromServerCrash,
    ...(isTestEnv
      ? {
          internalFetch,
          setupDesktopHeaderInjection,
          getCurrentServerOrigin: () => currentServerOrigin,
          matchesDesktopSecretForTesting: (candidate) => {
            if (typeof candidate !== "string" || !desktopSecret) return false;
            const bufA = Buffer.from(candidate);
            const bufB = Buffer.from(desktopSecret);
            return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
          },
          setDesktopSecretForTesting: (secret) => {
            desktopSecret = secret;
          },
          setBaseUrlForTesting: (url) => {
            baseUrl = url;
            try {
              currentServerOrigin = new URL(url).origin;
            } catch {
              currentServerOrigin = null;
            }
          },
        }
      : {}),
  };
}

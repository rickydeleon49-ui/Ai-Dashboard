const path = require("node:path");

function windowsEditorCandidates(env = process.env) {
  const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]].filter(Boolean);
  const relative = [
    ["Programs", "Microsoft VS Code", "Code.exe"],
    ["Microsoft VS Code", "Code.exe"],
    ["Programs", "Cursor", "Cursor.exe"],
    ["Cursor", "Cursor.exe"],
    ["Programs", "VSCodium", "VSCodium.exe"],
    ["VSCodium", "VSCodium.exe"],
  ];
  return [
    ...roots.flatMap((root) => relative.map((parts) => path.join(root, ...parts))),
    "Code.exe",
    "Cursor.exe",
    "VSCodium.exe",
  ];
}

function editorCandidates(platform = process.platform, env = process.env) {
  if (platform === "win32") return windowsEditorCandidates(env);
  if (platform === "darwin") return ["code", "cursor", "codium"];
  return ["code", "cursor", "codium"];
}

const TERMINALS = {
  win32: [
    { command: "wt.exe", args: [] },
    { command: "powershell.exe", args: ["-NoExit"] },
    { command: "cmd.exe", args: [] },
  ],
  darwin: [{ command: "open", args: ["-a", "Terminal", "."] }],
  linux: [
    { command: "x-terminal-emulator", args: [] },
    { command: "gnome-terminal", args: [] },
    { command: "konsole", args: [] },
    { command: "xterm", args: [] },
  ],
};

function terminalCandidates(platform = process.platform) {
  return TERMINALS[platform] ?? TERMINALS.linux;
}

/**
 * Launch the first candidate whose child process emits "spawn".
 * Missing executables fail asynchronously, so each candidate must be awaited.
 * shell is always false; Windows uses executable paths instead of .cmd shims.
 */
async function launchFirst(candidates, cwd, spawnImpl) {
  for (const candidate of candidates) {
    const { command, args } =
      typeof candidate === "string" ? { command: candidate, args: [] } : candidate;
    try {
      const launched = await new Promise((resolve, reject) => {
        const child = spawnImpl(command, args, {
          cwd,
          detached: true,
          stdio: "ignore",
          shell: false,
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.removeListener("error", reject);
          child.unref();
          resolve(command);
        });
      });
      return launched;
    } catch {
      // Missing or unavailable. Try the next configured application.
    }
  }
  return null;
}

module.exports = { editorCandidates, terminalCandidates, launchFirst };

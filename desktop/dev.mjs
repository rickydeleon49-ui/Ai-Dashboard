/**
 * Single-command desktop development.
 *
 * Starts `next dev`, waits for it to accept connections, then launches the
 * Electron shell against it. Hot reload works exactly as it does in a browser.
 * Quitting either one tears down the other, so no orphan server is left behind.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const PORT = Number(process.env.PORT ?? 3000);
const URL_ = `http://localhost:${PORT}`;

let shuttingDown = false;

/**
 * Resolves a dependency's executable from this project.
 *
 * Going through npx would silently fall back to some other copy when the
 * project has no node_modules, producing a confusing failure much later.
 */
function requireLocal(name, onMissing) {
  try {
    return require_(name);
  } catch {
    console.error(onMissing);
    process.exit(1);
  }
}

function nextBin() {
  try {
    const pkg = require_.resolve("next/package.json");
    return path.join(path.dirname(pkg), "dist", "bin", "next");
  } catch {
    console.error(
      "Next.js is not installed in this project.\n" +
        "Run `npm install` first, and make sure it finishes without errors.",
    );
    process.exit(1);
  }
}

function waitForPort(port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Next dev server did not start within ${timeoutMs / 1000}s`));
        } else {
          setTimeout(attempt, 200);
        }
      });
    };
    attempt();
  });
}

// No shell: argument quoting then behaves identically on every platform.
const next = spawn(process.execPath, [nextBin(), "dev", "--port", String(PORT)], {
  stdio: "inherit",
  env: process.env,
});

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!next.killed) next.kill();
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
next.on("exit", (code) => shutdown(code ?? 0));

console.log(`Waiting for ${URL_} …`);

try {
  await waitForPort(PORT);
} catch (error) {
  console.error(error.message);
  shutdown(1);
}

console.log("Launching desktop shell…");

// The electron package exports the path to its own binary.
const electronBin = requireLocal(
  "electron",
  "Electron is not installed in this project.\n" +
    "Run `npm install` first, and make sure it finishes without errors.",
);

const electron = spawn(electronBin, ["."], {
  stdio: "inherit",
  env: { ...process.env, DESKTOP_DEV_URL: URL_ },
});

electron.on("exit", (code) => shutdown(code ?? 0));

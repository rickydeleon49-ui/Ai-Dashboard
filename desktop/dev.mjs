/**
 * Single-command desktop development.
 *
 * Starts `next dev`, waits for it to accept connections, then launches the
 * Electron shell against it. Hot reload works exactly as it does in a browser.
 * Quitting either one tears down the other, so no orphan server is left behind.
 */
import { spawn } from "node:child_process";
import net from "node:net";

const PORT = Number(process.env.PORT ?? 3000);
const URL_ = `http://localhost:${PORT}`;

const isWindows = process.platform === "win32";
let shuttingDown = false;

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

const next = spawn("npx", ["next", "dev", "--port", String(PORT)], {
  stdio: "inherit",
  shell: isWindows,
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

const electron = spawn("npx", ["electron", "."], {
  stdio: "inherit",
  shell: isWindows,
  env: { ...process.env, DESKTOP_DEV_URL: URL_ },
});

electron.on("exit", (code) => shutdown(code ?? 0));

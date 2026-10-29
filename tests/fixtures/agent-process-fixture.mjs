// Tiny fake agent used by tests/unit/agent-process.test.ts.
// Usage: node agent-process-fixture.mjs <mode> [...args]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [, , mode, ...rest] = process.argv;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (mode === "lines") {
  // An object split across two writes, a non-JSON line, stderr, exit code 3.
  process.stdout.write('{"a":1}\n{"b"');
  await sleep(60);
  process.stdout.write(':2}\nnot json\n');
  process.stderr.write("oops\n");
  await sleep(30);
  process.exit(3);
} else if (mode === "args") {
  process.stdout.write(JSON.stringify({ args: rest }) + "\n");
} else if (mode === "brace") {
  // A lone "{" is valid-looking but yields no JSON value.
  process.stdout.write("{" + String.fromCharCode(10) + '{"ok":1}' + String.fromCharCode(10));
} else if (mode === "orphan") {
  // Spawn a grandchild (same process group on POSIX), record its pid, then exit.
  const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
    detached: process.platform === "win32",
  });
  writeFileSync(rest[0], String(gc.pid));
  process.exit(0);
} else if (mode === "exit") {
  process.exit(Number(rest[0] ?? 0));
} else if (mode === "tree") {
  // Spawn a grandchild that keeps running, record its pid, then stay alive.
  const pidFile = rest[0];
  // On Windows libuv puts every node process in a kill-on-close Job Object, so
  // an ordinary grandchild dies with its parent and would make the test
  // vacuous. `detached` breaks away from that job (as a real agent's tool
  // server might), leaving only taskkill /T to find it. On POSIX it must stay
  // in the parent's process group, so it is not detached there.
  const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
    detached: process.platform === "win32",
  });
  writeFileSync(pidFile, String(gc.pid));
  process.stdout.write(JSON.stringify({ ready: true, grandchild: gc.pid }) + "\n");
  setInterval(() => {}, 1000);
} else {
  process.stderr.write("unknown mode\n");
  process.exit(9);
}

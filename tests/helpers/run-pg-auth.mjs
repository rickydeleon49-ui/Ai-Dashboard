import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stubPath = path.resolve(__dirname, "stub-server-only.cjs").replace(/\\/g, "/");

const nodeOptions = process.env.NODE_OPTIONS
  ? `${process.env.NODE_OPTIONS} --require "${stubPath}"`
  : `--require "${stubPath}"`;

const isWindows = process.platform === "win32";
const args = [
  "tsx",
  "--test",
  "--test-concurrency=1",
  "tests/unit-pg-auth/auth.test.ts",
  "tests/unit-pg-auth/ownership-claim-api.test.ts",
  "tests/unit-pg-auth/proxy-accounts-mode.test.ts",
  "tests/unit-pg-auth/files-accounts-mode.test.ts",
  "tests/unit-pg-auth/members-api.test.ts",
];

const result = spawnSync(isWindows ? "npx.cmd" : "npx", args, {
  stdio: "inherit",
  shell: isWindows,
  env: {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
    AUTH_LOG_MAGIC_LINK: "true",
  },
});

process.exit(result.status ?? 1);

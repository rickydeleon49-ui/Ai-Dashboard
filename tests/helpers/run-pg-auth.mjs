import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stubPath = path.resolve(__dirname, "stub-server-only.cjs").replace(/\\/g, "/");

const nodeOptions = process.env.NODE_OPTIONS
  ? `${process.env.NODE_OPTIONS} --require "${stubPath}"`
  : `--require "${stubPath}"`;

const isWindows = process.platform === "win32";
const defaultFiles = [
  "tests/unit-pg-auth/auth.test.ts",
  "tests/unit-pg-auth/ownership-claim-api.test.ts",
  "tests/unit-pg-auth/proxy-accounts-mode.test.ts",
  "tests/unit-pg-auth/files-accounts-mode.test.ts",
  "tests/unit-pg-auth/members-api.test.ts",
  "tests/unit-pg-auth/task-assignment-api.test.ts",
  "tests/unit-pg-auth/task-checklists-api.test.ts",
  "tests/unit-pg-auth/task-comments-api.test.ts",
  "tests/unit-pg-auth/activity-redaction-api.test.ts",
  "tests/unit-pg-auth/bulk-tasks-api.test.ts",
  "tests/unit-pg-auth/collaboration-notifications-api.test.ts",
  "tests/unit-pg-auth/calendar-api.test.ts",
  "tests/unit-pg-auth/timeline-api.test.ts",
  "tests/unit-pg-auth/templates-api.test.ts",
  "tests/unit-pg-auth/knowledge-workspace-scoping.test.ts",
];

const targetFiles = process.argv.slice(2);
const args = [
  "tsx",
  "--test",
  "--test-concurrency=1",
  ...(targetFiles.length > 0 ? targetFiles : defaultFiles),
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

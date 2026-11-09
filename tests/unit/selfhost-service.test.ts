import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("self-hosted service scripts and documentation (AW5-04)", () => {
  const startScriptPath = path.join(REPO_ROOT, "scripts/service/start-selfhosted.sh");
  const serviceUnitPath = path.join(REPO_ROOT, "scripts/service/command-center.service");
  const launchdPlistPath = path.join(REPO_ROOT, "scripts/service/com.commandcenter.selfhosted.plist");
  const envExamplePath = path.join(REPO_ROOT, ".env.selfhosted.example");
  const readmePath = path.join(REPO_ROOT, "README.md");

  describe("start-selfhosted.sh", () => {
    it("exists and is valid bash with strict mode", () => {
      assert.ok(fs.existsSync(startScriptPath), "start-selfhosted.sh must exist");
      const content = fs.readFileSync(startScriptPath, "utf8");
      assert.ok(content.startsWith("#!/usr/bin/env bash"), "must have bash shebang");
      assert.ok(content.includes("set -euo pipefail"), "must enable strict error flags");
    });

    it("loads optional .env.selfhosted next to repo root", () => {
      const content = fs.readFileSync(startScriptPath, "utf8");
      assert.ok(content.includes(".env.selfhosted"), "must reference .env.selfhosted");
    });

    it("refuses to start if AGENT_HOST_MODE is not self-hosted or HOSTNAME is unset", () => {
      const content = fs.readFileSync(startScriptPath, "utf8");
      assert.ok(content.includes("AGENT_HOST_MODE"), "must check AGENT_HOST_MODE");
      assert.ok(content.includes("self-hosted"), "must check for self-hosted mode");
      assert.ok(content.includes("HOSTNAME"), "must check HOSTNAME");
    });

    it("starts runner in background and Next.js server in foreground, stopping runner on exit", () => {
      const content = fs.readFileSync(startScriptPath, "utf8");
      assert.ok(content.includes("npm run runner &"), "must start runner in background");
      assert.ok(
        content.includes('npm run start -- -H "$HOSTNAME" -p "${PORT:-3000}"'),
        "must start Next.js with -H and -p",
      );
      assert.ok(content.includes("trap cleanup EXIT INT TERM"), "must trap EXIT, INT, and TERM");
      assert.ok(content.includes("kill -TERM"), "must terminate runner on cleanup");
    });
  });

  describe("command-center.service", () => {
    it("exists and configures systemd user service with hardening", () => {
      assert.ok(fs.existsSync(serviceUnitPath), "command-center.service must exist");
      const content = fs.readFileSync(serviceUnitPath, "utf8");
      assert.ok(content.includes("Restart=on-failure"), "must have Restart=on-failure");
      assert.ok(content.includes("NoNewPrivileges=yes"), "must have NoNewPrivileges=yes");
      assert.ok(content.includes("PrivateTmp=yes"), "must have PrivateTmp=yes");
      assert.ok(content.includes("ProtectSystem=strict"), "must have ProtectSystem=strict");
      assert.ok(content.includes("WantedBy=default.target"), "must target user default.target");
      assert.ok(content.includes("start-selfhosted.sh"), "must run start-selfhosted.sh");
      assert.ok(/#\s*ReadWritePaths=/.test(content), "must include commented ReadWritePaths placeholders");
    });
  });

  describe("com.commandcenter.selfhosted.plist", () => {
    it("exists and configures launchd LaunchAgent", () => {
      assert.ok(fs.existsSync(launchdPlistPath), "com.commandcenter.selfhosted.plist must exist");
      const content = fs.readFileSync(launchdPlistPath, "utf8");
      assert.ok(content.includes("com.commandcenter.selfhosted"), "must have service label");
      assert.ok(content.includes("start-selfhosted.sh"), "must run start-selfhosted.sh");
      assert.ok(content.includes("<key>KeepAlive</key>"), "must configure KeepAlive");
      assert.ok(content.includes("<key>SuccessfulExit</key>"), "must restart on failure");
      assert.ok(content.includes("/path/to/"), "must have path placeholders");
    });
  });

  describe(".env.selfhosted.example", () => {
    it("contains dummy values and documents invariants", () => {
      assert.ok(fs.existsSync(envExamplePath), ".env.selfhosted.example must exist");
      const content = fs.readFileSync(envExamplePath, "utf8");
      assert.ok(content.includes("AGENT_HOST_MODE=self-hosted"));
      assert.ok(content.includes("HOSTNAME=127.0.0.1"));
      assert.ok(content.includes("PORT=3000"));
      assert.ok(content.includes("DATABASE_PATH"));
      assert.ok(content.includes("OPERATOR_FILE"));
      assert.ok(content.includes("AUTH_MODE=accounts"), "must document forbidden accounts mode");
      assert.ok(content.includes("DASHBOARD_PASSWORD"), "must document forbidden password mode");
      assert.ok(content.includes("RAILWAY_"), "must document forbidden Railway env");
      assert.ok(content.includes("DASHBOARD_LOCAL"), "must document forbidden desktop env");
    });
  });

  describe("README self-hosted section", () => {
    it("documents self-hosted mode with safety rules and setup steps", () => {
      assert.ok(fs.existsSync(readmePath), "README.md must exist");
      const content = fs.readFileSync(readmePath, "utf8");
      assert.ok(content.includes("## Self-hosted mode (preview)"));
      assert.ok(content.includes("AGENT_HOST_MODE=self-hosted"));
      assert.ok(content.includes("127.0.0.1"));
      assert.ok(content.includes("tailscale serve"));
      assert.ok(content.includes("npm run operator:password"));
      assert.ok(content.includes("Windows: not supported as a service yet"));
    });
  });
});

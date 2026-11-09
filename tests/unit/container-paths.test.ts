import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  toContainerPath,
  toHostPath,
  type ContainerMounts,
} from "@/core/agents/container/paths";

describe("container-paths", () => {
  const winMounts: ContainerMounts = {
    worktree: "C:\\projects\\app",
    grantDir: "C:\\projects\\runs\\run-1",
    codexRunDir: "C:\\projects\\runs\\run-1\\codex\\planner-r0",
  };

  const posixMounts: ContainerMounts = {
    worktree: "/home/user/project",
    grantDir: "/var/runs/run-1",
    codexRunDir: "/var/runs/run-1/codex/planner-r0",
  };

  describe("round trips on both platforms", () => {
    it("round trips host -> container -> host on win32", () => {
      const cases = [
        winMounts.worktree,
        "C:\\projects\\app\\package.json",
        "C:\\projects\\app\\src\\index.ts",
        "C:\\projects\\app\\nested\\deep\\file.ext",
        winMounts.grantDir,
        "C:\\projects\\runs\\run-1\\grant.json",
        "C:\\projects\\runs\\run-1\\other-role\\manifest.json",
        winMounts.codexRunDir!,
        "C:\\projects\\runs\\run-1\\codex\\planner-r0\\prompt.md",
        "C:\\projects\\runs\\run-1\\codex\\planner-r0\\nested\\result.json",
      ];

      for (const hostPath of cases) {
        const containerPath = toContainerPath(winMounts, hostPath, "win32");
        assert.ok(containerPath.startsWith("/"), `expected POSIX path, got: ${containerPath}`);
        assert.equal(containerPath.includes("\\"), false, `backslashes found: ${containerPath}`);
        const roundTripHost = toHostPath(winMounts, containerPath, "win32");
        assert.equal(roundTripHost, hostPath);
      }
    });

    it("round trips container -> host -> container on win32", () => {
      const cases = [
        "/workspace",
        "/workspace/package.json",
        "/workspace/src/index.ts",
        "/workspace/nested/deep/file.ext",
        "/run/grant",
        "/run/grant/grant.json",
        "/run/grant/other-role/manifest.json",
        "/run/codex",
        "/run/codex/prompt.md",
        "/run/codex/nested/result.json",
      ];

      for (const containerPath of cases) {
        const hostPath = toHostPath(winMounts, containerPath, "win32");
        assert.ok(/^[A-Za-z]:\\/.test(hostPath), `expected win32 absolute path, got: ${hostPath}`);
        const roundTripContainer = toContainerPath(winMounts, hostPath, "win32");
        assert.equal(roundTripContainer, containerPath);
      }
    });

    it("round trips host -> container -> host on posix", () => {
      const cases = [
        posixMounts.worktree,
        "/home/user/project/package.json",
        "/home/user/project/src/index.ts",
        "/home/user/project/nested/deep/file.ext",
        posixMounts.grantDir,
        "/var/runs/run-1/grant.json",
        "/var/runs/run-1/other-role/manifest.json",
        posixMounts.codexRunDir!,
        "/var/runs/run-1/codex/planner-r0/prompt.md",
        "/var/runs/run-1/codex/planner-r0/nested/result.json",
      ];

      for (const hostPath of cases) {
        const containerPath = toContainerPath(posixMounts, hostPath, "linux");
        assert.ok(containerPath.startsWith("/"), `expected POSIX path, got: ${containerPath}`);
        const roundTripHost = toHostPath(posixMounts, containerPath, "linux");
        assert.equal(roundTripHost, hostPath);
      }
    });

    it("round trips container -> host -> container on posix", () => {
      const cases = [
        "/workspace",
        "/workspace/package.json",
        "/workspace/src/index.ts",
        "/workspace/nested/deep/file.ext",
        "/run/grant",
        "/run/grant/grant.json",
        "/run/grant/other-role/manifest.json",
        "/run/codex",
        "/run/codex/prompt.md",
        "/run/codex/nested/result.json",
      ];

      for (const containerPath of cases) {
        const hostPath = toHostPath(posixMounts, containerPath, "linux");
        assert.ok(hostPath.startsWith("/"), `expected posix absolute path, got: ${hostPath}`);
        const roundTripContainer = toContainerPath(posixMounts, hostPath, "linux");
        assert.equal(roundTripContainer, containerPath);
      }
    });
  });

  describe("case-insensitive win32 match", () => {
    it("matches regardless of drive letter or path casing on win32", () => {
      const mounts: ContainerMounts = {
        worktree: "C:\\Projects\\MyApp",
        grantDir: "C:\\Runs\\Grant-1",
      };

      assert.equal(
        toContainerPath(mounts, "c:\\projects\\myapp\\src\\index.ts", "win32"),
        "/workspace/src/index.ts",
      );
      assert.equal(
        toContainerPath(mounts, "C:\\PROJECTS\\MYAPP\\src\\index.ts", "win32"),
        "/workspace/src/index.ts",
      );
      assert.equal(
        toContainerPath(mounts, "c:\\Projects\\MyApp", "win32"),
        "/workspace",
      );
      assert.equal(
        toContainerPath(mounts, "c:\\runs\\grant-1\\token.json", "win32"),
        "/run/grant/token.json",
      );
    });

    it("preserves casing of relative child segments on win32", () => {
      const mounts: ContainerMounts = {
        worktree: "C:\\Projects\\MyApp",
        grantDir: "C:\\Runs\\Grant-1",
      };

      assert.equal(
        toContainerPath(mounts, "c:\\projects\\myapp\\Src\\MyComponent.tsx", "win32"),
        "/workspace/Src/MyComponent.tsx",
      );
    });

    it("accepts forward slashes in win32 host paths", () => {
      const mounts: ContainerMounts = {
        worktree: "C:\\Projects\\MyApp",
        grantDir: "C:\\Runs\\Grant-1",
      };

      assert.equal(
        toContainerPath(mounts, "c:/projects/myapp/src/index.ts", "win32"),
        "/workspace/src/index.ts",
      );
    });

    it("rejects case mismatches on posix", () => {
      const mounts: ContainerMounts = {
        worktree: "/Projects/MyApp",
        grantDir: "/Runs/Grant-1",
      };

      assert.throws(
        () => toContainerPath(mounts, "/projects/myapp/src/index.ts", "linux"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toContainerPath(mounts, "/runs/grant-1/token.json", "linux"),
        /path outside container mounts/,
      );
    });
  });

  describe("prefix trick rejected", () => {
    it("rejects prefix trick in toContainerPath on win32", () => {
      assert.throws(
        () => toContainerPath(winMounts, "C:\\projects\\app-evil", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toContainerPath(winMounts, "C:\\projects\\app-evil\\file.txt", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toContainerPath(winMounts, "C:\\projects\\app2\\file.txt", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toContainerPath(winMounts, "C:\\projects\\runs\\run-1-evil\\file.txt", "win32"),
        /path outside container mounts/,
      );
    });

    it("rejects prefix trick in toContainerPath on posix", () => {
      assert.throws(
        () => toContainerPath(posixMounts, "/home/user/project-evil", "linux"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toContainerPath(posixMounts, "/home/user/project-evil/file.txt", "linux"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toContainerPath(posixMounts, "/var/runs/run-1-evil", "linux"),
        /path outside container mounts/,
      );
    });

    it("rejects prefix trick in toHostPath on win32 and posix", () => {
      assert.throws(
        () => toHostPath(winMounts, "/workspace-evil", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(winMounts, "/workspace-evil/file.txt", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(winMounts, "/workspace2", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(winMounts, "/run/grant-evil", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(winMounts, "/run/grant-evil/file.txt", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(winMounts, "/run/codex-evil", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(winMounts, "/run/codex-evil/file.txt", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(posixMounts, "/workspace-evil/file.txt", "linux"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(posixMounts, "/run", "linux"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(posixMounts, "/run/other", "linux"),
        /path outside container mounts/,
      );
    });
  });

  describe(".. rejected both ways", () => {
    it("rejects .. in toContainerPath", () => {
      // win32
      assert.throws(
        () => toContainerPath(winMounts, "C:\\projects\\app\\..\\evil", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toContainerPath(winMounts, "C:\\projects\\app\\..", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toContainerPath(winMounts, "C:\\projects\\app\\src\\..\\evil", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toContainerPath(winMounts, "C:\\projects\\app\\src\\..\\index.ts", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toContainerPath(winMounts, "C:/projects/app/../evil", "win32"),
        /path outside container mounts/,
      );

      // posix
      assert.throws(
        () => toContainerPath(posixMounts, "/home/user/project/../evil", "linux"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toContainerPath(posixMounts, "/home/user/project/..", "linux"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toContainerPath(posixMounts, "/home/user/project/src/../index.ts", "linux"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toContainerPath(posixMounts, "../home/user/project", "linux"),
        /path outside container mounts/,
      );
    });

    it("rejects .. in toHostPath", () => {
      // win32
      assert.throws(
        () => toHostPath(winMounts, "/workspace/..", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(winMounts, "/workspace/../evil", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(winMounts, "/workspace/src/../index.ts", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(winMounts, "/run/grant/..", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(winMounts, "/run/grant/../evil", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(winMounts, "/run/codex/..", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(winMounts, "/run/codex/../evil", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(winMounts, "../workspace", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(winMounts, "..", "win32"),
        /path outside container mounts/,
      );

      // posix
      assert.throws(
        () => toHostPath(posixMounts, "/workspace/..", "linux"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(posixMounts, "/workspace/../evil", "linux"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(posixMounts, "/run/grant/../evil", "linux"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(posixMounts, "../workspace", "linux"),
        /path outside container mounts/,
      );
    });
  });

  describe("longest mount wins", () => {
    it("selects codexRunDir over grantDir when host path is inside codexRunDir on win32", () => {
      const hostInsideCodex = "C:\\projects\\runs\\run-1\\codex\\planner-r0\\output.json";
      assert.equal(
        toContainerPath(winMounts, hostInsideCodex, "win32"),
        "/run/codex/output.json",
      );

      const codexRoot = "C:\\projects\\runs\\run-1\\codex\\planner-r0";
      assert.equal(toContainerPath(winMounts, codexRoot, "win32"), "/run/codex");

      const hostInsideGrantOnly = "C:\\projects\\runs\\run-1\\manifest.json";
      assert.equal(
        toContainerPath(winMounts, hostInsideGrantOnly, "win32"),
        "/run/grant/manifest.json",
      );

      const anotherRole = "C:\\projects\\runs\\run-1\\codex\\reviewer-r0\\output.json";
      assert.equal(
        toContainerPath(winMounts, anotherRole, "win32"),
        "/run/grant/codex/reviewer-r0/output.json",
      );
    });

    it("selects codexRunDir over grantDir when host path is inside codexRunDir on posix", () => {
      const hostInsideCodex = "/var/runs/run-1/codex/planner-r0/output.json";
      assert.equal(
        toContainerPath(posixMounts, hostInsideCodex, "linux"),
        "/run/codex/output.json",
      );

      const codexRoot = "/var/runs/run-1/codex/planner-r0";
      assert.equal(toContainerPath(posixMounts, codexRoot, "linux"), "/run/codex");

      const hostInsideGrantOnly = "/var/runs/run-1/manifest.json";
      assert.equal(
        toContainerPath(posixMounts, hostInsideGrantOnly, "linux"),
        "/run/grant/manifest.json",
      );
    });
  });

  describe("missing codexRunDir rejects /run/codex", () => {
    const mountsWithoutCodexWin: ContainerMounts = {
      worktree: "C:\\projects\\app",
      grantDir: "C:\\projects\\runs\\run-1",
    };

    const mountsWithoutCodexPosix: ContainerMounts = {
      worktree: "/home/user/project",
      grantDir: "/var/runs/run-1",
    };

    it("rejects /run/codex in toHostPath on win32", () => {
      assert.throws(
        () => toHostPath(mountsWithoutCodexWin, "/run/codex", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(mountsWithoutCodexWin, "/run/codex/file.txt", "win32"),
        /path outside container mounts/,
      );
    });

    it("rejects /run/codex in toHostPath on posix", () => {
      assert.throws(
        () => toHostPath(mountsWithoutCodexPosix, "/run/codex", "linux"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(mountsWithoutCodexPosix, "/run/codex/file.txt", "linux"),
        /path outside container mounts/,
      );
    });

    it("maps paths inside grantDir to /run/grant when codexRunDir is absent", () => {
      const hostPath = "C:\\projects\\runs\\run-1\\codex\\planner-r0\\output.json";
      assert.equal(
        toContainerPath(mountsWithoutCodexWin, hostPath, "win32"),
        "/run/grant/codex/planner-r0/output.json",
      );
    });
  });

  describe("invalid and boundary inputs", () => {
    it("rejects relative input in toHostPath", () => {
      assert.throws(
        () => toHostPath(winMounts, "workspace/file.txt", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(winMounts, "./workspace/file.txt", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(winMounts, "", "win32"),
        /path outside container mounts/,
      );
    });

    it("rejects paths outside mounts in toHostPath", () => {
      assert.throws(
        () => toHostPath(winMounts, "/etc/passwd", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(winMounts, "/", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toHostPath(winMounts, "/var/log/syslog", "win32"),
        /path outside container mounts/,
      );
    });

    it("rejects relative input in toContainerPath", () => {
      assert.throws(
        () => toContainerPath(winMounts, "src\\index.ts", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toContainerPath(winMounts, ".\\src\\index.ts", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toContainerPath(winMounts, "", "win32"),
        /path outside container mounts/,
      );
    });

    it("rejects paths outside mounts in toContainerPath", () => {
      assert.throws(
        () => toContainerPath(winMounts, "D:\\other\\file.txt", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toContainerPath(winMounts, "C:\\other\\file.txt", "win32"),
        /path outside container mounts/,
      );
      assert.throws(
        () => toContainerPath(posixMounts, "/other/path/file.txt", "linux"),
        /path outside container mounts/,
      );
    });

    it("handles trailing slashes on mount definitions cleanly", () => {
      const mountsWithTrailing: ContainerMounts = {
        worktree: "C:\\projects\\app\\",
        grantDir: "C:\\projects\\runs\\run-1\\",
      };

      assert.equal(
        toContainerPath(mountsWithTrailing, "C:\\projects\\app\\file.txt", "win32"),
        "/workspace/file.txt",
      );
      assert.equal(
        toContainerPath(mountsWithTrailing, "C:\\projects\\app", "win32"),
        "/workspace",
      );
      assert.equal(
        toHostPath(mountsWithTrailing, "/workspace/file.txt", "win32"),
        "C:\\projects\\app\\file.txt",
      );
      assert.equal(
        toHostPath(mountsWithTrailing, "/workspace", "win32"),
        "C:\\projects\\app",
      );
    });

    it("defaults platform to process.platform when omitted", () => {
      const isWin = process.platform === "win32";
      const mounts = isWin ? winMounts : posixMounts;
      const hostFile = isWin
        ? "C:\\projects\\app\\file.txt"
        : "/home/user/project/file.txt";

      const container = toContainerPath(mounts, hostFile);
      assert.equal(container, "/workspace/file.txt");
      const back = toHostPath(mounts, container);
      assert.equal(back, hostFile);
    });
  });
});

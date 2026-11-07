/**
 * Unit tests for diffPatch (Release AW.1, AW1-15): patch text per changed file
 * from one git diff, on a real temp repository in a folder with spaces.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  DIFF_PATCH_FILE_CAP_BYTES,
  DIFF_PATCH_TOTAL_CAP_BYTES,
  diffPatch,
  execGit,
} from "../../src/core/agents/workspace";

const SECRET = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

let tmpDir: string;
let repoDir: string;
let baseSha: string;

async function commitAll(dir: string, msg: string): Promise<void> {
  await execGit(["add", "-A"], { cwd: dir });
  await execGit(["-c", "user.name=T", "-c", "user.email=t@example.local", "commit", "-m", msg], { cwd: dir });
}

before(async () => {
  tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "agent patch test-")));
  repoDir = path.join(tmpDir, "repo with spaces");
  fs.mkdirSync(repoDir, { recursive: true });
  await execGit(["init", "-b", "main"], { cwd: repoDir });
  await execGit(["config", "core.autocrlf", "false"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "mod.txt"), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(repoDir, "old-name.txt"), "rename me please\nsecond line\nthird line\nfourth line\n");
  fs.writeFileSync(path.join(repoDir, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
  fs.mkdirSync(path.join(repoDir, "secrets"));
  fs.writeFileSync(path.join(repoDir, "secrets", "keep.txt"), "old\n");
  await commitAll(repoDir, "initial");
  baseSha = (await execGit(["rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();

  fs.writeFileSync(path.join(repoDir, "mod.txt"), `one\nTWO\nthree\ntoken = ${SECRET}\n`);
  fs.writeFileSync(path.join(repoDir, "added file.txt"), "brand new\n");
  fs.renameSync(path.join(repoDir, "old-name.txt"), path.join(repoDir, "new-name.txt"));
  fs.writeFileSync(path.join(repoDir, "bin.dat"), Buffer.from([0, 9, 9, 9, 0, 1, 2]));
  fs.writeFileSync(path.join(repoDir, "secrets", "keep.txt"), "TOP SECRET CONTENT\n");
  await commitAll(repoDir, "changes");
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("diffPatch", () => {
  it("exports the default caps", () => {
    assert.equal(DIFF_PATCH_FILE_CAP_BYTES, 64 * 1024);
    assert.equal(DIFF_PATCH_TOTAL_CAP_BYTES, 512 * 1024);
  });

  it("returns patches for modified, added, renamed, binary and excluded files", async () => {
    const res = await diffPatch(repoDir, baseSha, { excludedPaths: ["secrets/**"] });
    assert.equal(res.truncated, false);
    const byPath = new Map(res.files.map((f) => [f.path, f]));
    assert.equal(res.files.length, 5);

    const mod = byPath.get("mod.txt")!;
    assert.match(mod.patch, /^diff --git a\/mod\.txt b\/mod\.txt/);
    assert.match(mod.patch, /^-two$/m);
    assert.match(mod.patch, /^\+TWO$/m);
    assert.equal(mod.truncated, false);

    const added = byPath.get("added file.txt")!;
    assert.match(added.patch, /^\+brand new$/m);

    const renamed = byPath.get("new-name.txt")!;
    assert.equal(renamed.oldPath, "old-name.txt");
    assert.match(renamed.patch, /rename from old-name\.txt/);

    const bin = byPath.get("bin.dat")!;
    assert.equal(bin.patch, "");
    assert.equal(bin.truncated, false);

    const excluded = byPath.get("secrets/keep.txt")!;
    assert.equal(excluded.patch, "");
    assert.equal(excluded.truncated, false);
    assert.equal(JSON.stringify(res).includes("TOP SECRET CONTENT"), false);
  });

  it("redacts secrets in changed lines", async () => {
    const res = await diffPatch(repoDir, baseSha);
    const mod = res.files.find((f) => f.path === "mod.txt")!;
    assert.equal(mod.patch.includes(SECRET), false);
    assert.match(mod.patch, /\[REDACTED\]/);
  });

  it("caps each file and keeps the first part with truncated: true", async () => {
    const res = await diffPatch(repoDir, baseSha, { maxFileBytes: 120 });
    const mod = res.files.find((f) => f.path === "mod.txt")!;
    assert.equal(mod.truncated, true);
    assert.ok(Buffer.byteLength(mod.patch, "utf8") <= 120);
    assert.ok(mod.patch.startsWith("diff --git a/mod.txt"));
    assert.equal(res.truncated, true);
  });

  it("stops at the total cap: later files get an empty truncated patch", async () => {
    const res = await diffPatch(repoDir, baseSha, { maxTotalBytes: 200 });
    assert.equal(res.truncated, true);
    const text = res.files.filter((f) => f.patch !== "");
    const total = text.reduce((n, f) => n + Buffer.byteLength(f.patch, "utf8"), 0);
    assert.ok(total <= 200, `total ${total} within cap`);
    const dropped = res.files.filter((f) => f.patch === "" && f.truncated);
    assert.ok(dropped.length >= 1, "at least one file lost its patch to the total cap");
    assert.ok(res.files.some((f) => f.truncated));
  });

  it("refuses an unsafe baseSha", async () => {
    await assert.rejects(diffPatch(repoDir, "--output=x"), /Invalid baseSha/);
  });
});

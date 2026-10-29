/**
 * Unit tests for workspace roots, containment, drive check and locks
 * (Release AW.1, AW1-04). Real temp directories with spaces in their names;
 * injected realpath/platform for the Windows-only cases.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db";
import { agentRuns, agentWorkspaceLocks, projects } from "../../src/db/schema";
import {
  acquireWorkspaceLock,
  checkRootAvailable,
  getAgentStorageSettings,
  normalizeForCompare,
  releaseLocksForRun,
  releaseWorkspaceLock,
  resolveProjectPath,
  setRunStore,
  setWorkspaceRoots,
  validateStorageRoot,
  setWorktreeRoot,
  type SettingsStore,
} from "../../src/core/agents/roots";

let db: typeof import("../../src/db/client").db;
let tmp: string;
let rootDir: string; // "<tmp>/Ai Repo clones"
let outsideDir: string;

const WIN_KEY = ["h:", "wt", "command-center", "abc"].join(
  String.fromCharCode(92),
);
const identity = (p: string) => p;

function memoryStore(): SettingsStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
}

before(async () => {
  await migrate();
  ({ db } = await import("../../src/db/client"));
  tmp = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "aw1-04-")),
  );
  rootDir = path.join(tmp, "Ai Repo clones");
  outsideDir = path.join(tmp, "Elsewhere");
  fs.mkdirSync(path.join(rootDir, "proj one"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "Ai Repo clonesX", "evil"), { recursive: true });
  fs.mkdirSync(path.join(outsideDir, "secret"), { recursive: true });
});

after(async () => {
  await cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveProjectPath (AW1-04)", () => {
  it("accepts a path inside a root", () => {
    const r = resolveProjectPath(path.join(rootDir, "proj one"), [rootDir]);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.root, rootDir);
  });

  it("accepts the root itself", () => {
    assert.equal(resolveProjectPath(rootDir, [rootDir]).ok, true);
  });

  it("refuses a sibling sharing a name prefix", () => {
    const r = resolveProjectPath(path.join(tmp, "Ai Repo clonesX", "evil"), [
      rootDir,
    ]);
    assert.equal(r.ok, false);
  });

  it("refuses a .. escape", () => {
    const r = resolveProjectPath(
      path.join(rootDir, "..", "Elsewhere", "secret"),
      [rootDir],
    );
    assert.equal(r.ok, false);
  });

  it("refuses a link under the root that points outside", () => {
    const link = path.join(rootDir, "sneaky link");
    fs.symlinkSync(path.join(outsideDir, "secret"), link, "junction");
    const r = resolveProjectPath(link, [rootDir]);
    assert.equal(r.ok, false);
    fs.rmSync(link, { recursive: true, force: true });
  });

  it("refuses relative, UNC, device and missing paths", () => {
    assert.equal(resolveProjectPath("proj one", [rootDir]).ok, false);
    assert.equal(
      resolveProjectPath("\\\\server\\share\\x", ["C:\\r"], {
        platform: "win32",
        realpath: identity,
      }).ok,
      false,
    );
    assert.equal(
      resolveProjectPath("\\\\?\\C:\\r\\x", ["C:\\r"], {
        platform: "win32",
        realpath: identity,
      }).ok,
      false,
    );
    assert.equal(
      resolveProjectPath("C:relative", ["C:\\r"], {
        platform: "win32",
        realpath: identity,
      }).ok,
      false,
    );
    assert.equal(
      resolveProjectPath(path.join(rootDir, "does not exist"), [rootDir]).ok,
      false,
    );
  });

  it("is case-insensitive on win32 only (injected)", () => {
    const deps = (platform: NodeJS.Platform) => ({
      platform,
      realpath: identity,
    });
    assert.equal(
      resolveProjectPath(
        "H:\\ai repo clones\\p",
        ["H:\\Ai Repo clones"],
        deps("win32"),
      ).ok,
      true,
    );
    assert.equal(
      resolveProjectPath(
        "H:\\Ai Repo clonesX\\p",
        ["H:\\Ai Repo clones"],
        deps("win32"),
      ).ok,
      false,
    );
    assert.equal(
      resolveProjectPath("/srv/ai repo/p", ["/srv/Ai Repo"], deps("linux")).ok,
      false,
    );
    assert.equal(
      resolveProjectPath("/srv/Ai Repo/p", ["/srv/Ai Repo"], deps("linux")).ok,
      true,
    );
  });
});

describe("normalizeForCompare", () => {
  it("folds case and separators on win32 and darwin, not linux", () => {
    const w = normalizeForCompare("H:/Ai Repo/Proj/", "win32", identity);
    assert.equal(w, "h:\\ai repo\\proj");
    assert.equal(
      normalizeForCompare("/Users/Me/Proj/", "darwin", identity),
      "/users/me/proj",
    );
    assert.equal(
      normalizeForCompare("/Users/Me/Proj/", "linux", identity),
      "/Users/Me/Proj",
    );
  });
});

describe("checkRootAvailable", () => {
  it("is ok for an existing directory", () => {
    assert.deepEqual(checkRootAvailable(rootDir), { ok: true });
  });
  it("reports root unavailable for a missing root and never falls back", () => {
    assert.deepEqual(checkRootAvailable(path.join(tmp, "gone")), {
      ok: false,
      reason: "root unavailable",
    });
    assert.deepEqual(
      checkRootAvailable("Q:\\no\\such\\drive", { isDirectory: () => false }),
      {
        ok: false,
        reason: "root unavailable",
      },
    );
  });
});

describe("agent storage settings", () => {
  const userData = path.join(tmp ?? os.tmpdir(), "ud");

  it("returns the section 5 defaults", async () => {
    const s = await getAgentStorageSettings({ store: memoryStore(), userData });
    assert.equal(s.runStore, path.join(userData, "agent-runs"));
    assert.equal(s.worktreeRoot, path.join(userData, "agent-worktrees"));
    assert.deepEqual(s.workspaceRoots, []);
  });

  it("stores valid roots and worktree root", async () => {
    const store = memoryStore();
    const good = path.resolve(os.tmpdir(), "Ai Repo clones");
    const wt = path.resolve(os.tmpdir(), "Ai Repo worktrees");
    assert.deepEqual(await setWorkspaceRoots([good], { store, userData }), {
      ok: true,
    });
    assert.deepEqual(await setWorktreeRoot(wt, { store, userData }), {
      ok: true,
    });
    const s = await getAgentStorageSettings({ store, userData });
    assert.deepEqual(s.workspaceRoots, [good]);
    assert.equal(s.worktreeRoot, wt);
  });

  it("rejects a filesystem root, a relative path and a root inside the run store", async () => {
    const store = memoryStore();
    const bad = async (v: string) =>
      (await setWorkspaceRoots([v], { store, userData })).ok;
    assert.equal(await bad(path.parse(os.tmpdir()).root), false);
    assert.equal(await bad("relative/dir"), false);
    assert.equal(await bad(path.join(userData, "agent-runs", "inside")), false);
    // and the reverse: a root that contains the run store
    assert.equal(await bad(userData), false);
    assert.equal(
      (
        await setWorktreeRoot(path.join(userData, "agent-runs", "wt"), {
          store,
          userData,
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await setWorkspaceRoots(["C:\\"], {
          store,
          userData,
          platform: "win32",
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await setWorkspaceRoots(["\\\\srv\\share"], {
          store,
          userData,
          platform: "win32",
        })
      ).ok,
      false,
    );
    assert.deepEqual(
      (await getAgentStorageSettings({ store, userData })).workspaceRoots,
      [],
    );
  });
});

describe("workspace locks", () => {
  async function mkRun(id: string): Promise<void> {
    const pid = `prj-${id}`;
    await db.insert(projects).values({ id: pid, name: pid });
    await db.insert(agentRuns).values({
      id,
      projectId: pid,
      workspacePath: `/wt/${id}`,
      baseRef: "main",
    });
  }
  const win = { platform: "win32" as const, realpath: identity };

  it("a second lock on the same working copy is held by the first run (case-insensitive on win32)", async () => {
    await mkRun("lock-a");
    await mkRun("lock-b");
    assert.deepEqual(
      acquireWorkspaceLock(db, "lock-a", "H:\\Wt\\Command-Center\\abc", win),
      { ok: true, lockKey: WIN_KEY },
    );
    assert.deepEqual(
      acquireWorkspaceLock(db, "lock-b", "h:/wt/command-center/ABC/", win),
      {
        ok: false,
        heldBy: "lock-a",
        lockKey: WIN_KEY,
      },
    );
  });

  it("differently-cased paths are distinct locks on linux", async () => {
    await mkRun("lock-l1");
    await mkRun("lock-l2");
    const lin = { platform: "linux" as const, realpath: identity };
    assert.equal(acquireWorkspaceLock(db, "lock-l1", "/wt/Abc", lin).ok, true);
    assert.equal(acquireWorkspaceLock(db, "lock-l2", "/wt/abc", lin).ok, true);
  });

  it("release by another run is a no-op; release by the holder frees it", async () => {
    await mkRun("rel-a");
    await mkRun("rel-b");
    const p = path.join(rootDir, "proj one");
    const a = acquireWorkspaceLock(db, "rel-a", p);
    assert.equal(a.ok, true);
    const key = a.lockKey;
    releaseWorkspaceLock(db, "rel-b", key);
    assert.deepEqual(acquireWorkspaceLock(db, "rel-b", p), {
      ok: false,
      heldBy: "rel-a",
      lockKey: key,
    });
    releaseWorkspaceLock(db, "rel-a", key);
    assert.equal(acquireWorkspaceLock(db, "rel-b", p).ok, true);
  });

  it("a lock taken before creation conflicts after creation, even through a linked parent; release by key still works", async () => {
    await mkRun("late-a");
    await mkRun("late-b");
    const realParent = path.join(tmp, "real parent");
    const linkParent = path.join(tmp, "link parent");
    fs.mkdirSync(realParent, { recursive: true });
    fs.symlinkSync(realParent, linkParent, "junction");
    const viaLink = path.join(linkParent, "wt-1");
    const viaReal = path.join(realParent, "wt-1");
    const a = acquireWorkspaceLock(db, "late-a", viaLink); // does not exist yet
    assert.equal(a.ok, true);
    fs.mkdirSync(viaReal);
    const b = acquireWorkspaceLock(db, "late-b", viaLink);
    assert.deepEqual(b, { ok: false, heldBy: "late-a", lockKey: a.lockKey });
    const c = acquireWorkspaceLock(db, "late-b", viaReal);
    assert.deepEqual(c, { ok: false, heldBy: "late-a", lockKey: a.lockKey });
    releaseWorkspaceLock(db, "late-a", a.lockKey);
    assert.equal(
      db
        .select()
        .from(agentWorkspaceLocks)
        .all()
        .some((r) => r.lockKey === a.lockKey),
      false,
    );
    assert.equal(acquireWorkspaceLock(db, "late-b", viaReal).ok, true);
  });

  it("injected realpath: key is the same before and after creation", async () => {
    await mkRun("inj-a");
    await mkRun("inj-b");
    const created = new Set<string>();
    const real = (p: string): string => {
      const bs = String.fromCharCode(92);
      const m = p.replace("C:" + bs + "link", "C:" + bs + "target");
      if (m === "C:" + bs + "target" || created.has(m)) return m;
      throw new Error("ENOENT");
    };
    const deps = { platform: "win32" as const, realpath: real };
    const bs = String.fromCharCode(92);
    const wc = "C:" + bs + "link" + bs + "wt";
    const a = acquireWorkspaceLock(db, "inj-a", wc, deps);
    assert.equal(a.ok, true);
    created.add("C:" + bs + "target" + bs + "wt");
    const b = acquireWorkspaceLock(db, "inj-b", wc, deps);
    assert.equal(b.ok, false);
  });

  it("win32 trailing dots and spaces name the same working copy", async () => {
    await mkRun("dot-a");
    await mkRun("dot-b");
    await mkRun("dot-c");
    const bs = String.fromCharCode(92);
    const base = "H:" + bs + "wt" + bs + "run-1";
    assert.equal(acquireWorkspaceLock(db, "dot-a", base, win).ok, true);
    assert.equal(acquireWorkspaceLock(db, "dot-b", base + ".", win).ok, false);
    assert.equal(acquireWorkspaceLock(db, "dot-c", base + " ", win).ok, false);
  });

  it("releaseLocksForRun clears only that run's locks", async () => {
    await mkRun("all-a");
    await mkRun("all-b");
    acquireWorkspaceLock(db, "all-a", "/x/1", {
      platform: "linux",
      realpath: identity,
    });
    acquireWorkspaceLock(db, "all-a", "/x/2", {
      platform: "linux",
      realpath: identity,
    });
    acquireWorkspaceLock(db, "all-b", "/x/3", {
      platform: "linux",
      realpath: identity,
    });
    releaseLocksForRun(db, "all-a");
    const left = db
      .select()
      .from(agentWorkspaceLocks)
      .all()
      .filter((r) => r.runId.startsWith("all-"));
    assert.deepEqual(
      left.map((r) => r.runId),
      ["all-b"],
    );
  });

  it("works inside a caller's transaction and rolls back with it", async () => {
    await mkRun("tx-a");
    assert.throws(() =>
      db.transaction((tx) => {
        assert.equal(
          acquireWorkspaceLock(tx, "tx-a", "/tx/1", {
            platform: "linux",
            realpath: identity,
          }).ok,
          true,
        );
        throw new Error("rollback");
      }),
    );
    assert.equal(
      db
        .select()
        .from(agentWorkspaceLocks)
        .where(eq(agentWorkspaceLocks.runId, "tx-a"))
        .all().length,
      0,
    );
  });

  it("deleting a run cascades its locks", async () => {
    await mkRun("casc-a");
    acquireWorkspaceLock(db, "casc-a", "/casc/1", {
      platform: "linux",
      realpath: identity,
    });
    await db.delete(agentRuns).where(eq(agentRuns.id, "casc-a"));
    assert.equal(
      db
        .select()
        .from(agentWorkspaceLocks)
        .where(eq(agentWorkspaceLocks.runId, "casc-a"))
        .all().length,
      0,
    );
  });
});

describe("storage settings hardening (AW1-04 review)", () => {
  const bs = String.fromCharCode(92);
  const w = (...p: string[]) => p.join(bs);
  const ud = w("C:", "Users", "me", "AppData", "ud");
  const base = { userData: ud, platform: "win32" as const };

  it("defaults pass validation against each other", async () => {
    const s = await getAgentStorageSettings({
      store: memoryStore(),
      userData: ud,
      platform: "win32",
    });
    assert.equal(s.worktreeRoot, path.join(ud, "agent-worktrees"));
    const r1 = validateStorageRoot(s.worktreeRoot, s.runStore, "win32", {
      realpath: () => {
        throw new Error("ENOENT");
      },
    });
    assert.deepEqual(r1, { ok: true });
  });

  it("workspace roots and worktree root may not nest either way", async () => {
    const store = memoryStore();
    const o = { ...base, store, realpath: (p: string) => p };
    assert.equal((await setWorkspaceRoots([w("H:", "Repos")], o)).ok, true);
    assert.equal((await setWorktreeRoot(w("H:", "Repos", "wt"), o)).ok, false);
    assert.equal((await setWorktreeRoot(w("H:"), o)).ok, false);
    assert.equal((await setWorktreeRoot(w("H:", "Worktrees"), o)).ok, true);
    assert.equal(
      (await setWorkspaceRoots([w("H:", "Worktrees", "x")], o)).ok,
      false,
    );
    assert.equal(
      (await setWorkspaceRoots([w("H:", "Repos"), w("H:")], o)).ok,
      false,
    );
  });

  it("a root that is a link to a drive root is refused (set and resolve)", async () => {
    const store = memoryStore();
    const real = (p: string) => (p === w("H:", "clones") ? w("C:") + bs : p);
    const o = { ...base, store, realpath: real };
    const r = await setWorkspaceRoots([w("H:", "clones")], o);
    assert.equal(r.ok, false);
    const res = resolveProjectPath(w("C:", "Windows"), [w("H:", "clones")], {
      platform: "win32",
      realpath: real,
    });
    assert.equal(res.ok, false);
  });

  it("a root that links into the run store is refused", async () => {
    const store = memoryStore();
    const real = (p: string) =>
      p === w("H:", "clones") ? w(ud, "agent-runs", "x") : p;
    const r = await setWorkspaceRoots([w("H:", "clones")], {
      ...base,
      store,
      realpath: real,
    });
    assert.equal(r.ok, false);
  });

  it("setRunStore validates and does not nest with roots", async () => {
    const store = memoryStore();
    const o = { ...base, store, realpath: (p: string) => p };
    assert.equal((await setWorkspaceRoots([w("H:", "Repos")], o)).ok, true);
    assert.equal((await setRunStore(w("C:") + bs, o)).ok, false);
    assert.equal((await setRunStore("relative", o)).ok, false);
    assert.equal((await setRunStore(w("H:", "Repos", "runs"), o)).ok, false);
    assert.equal(
      (await setRunStore(w(ud, "agent-worktrees", "r"), o)).ok,
      false,
    );
    assert.equal((await setRunStore(w("D:", "runs"), o)).ok, true);
    const s = await getAgentStorageSettings(o);
    assert.equal(s.runStore, w("D:", "runs"));
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ANTIGRAVITY_TOOL_ALLOWLIST,
  ToolMonitor,
  describeViolation,
  stopOnViolation,
  type MonitorDecision,
} from "../../src/core/agents/tool-monitor";

const identity = async (p: string) => p;

function winMonitor(worktree = "H:\\work\\t1", home = "C:\\Users\\user") {
  return new ToolMonitor({ worktree, home, platform: "win32", realpath: identity });
}
function posixMonitor(worktree = "/work/t1", home = "/home/user") {
  return new ToolMonitor({ worktree, home, platform: "linux", realpath: identity });
}
function step(tool: string, parameters: Record<string, unknown>, state = "ACTIVE") {
  return {
    step_index: 3,
    state,
    step_type: "tool",
    tool_name: tool,
    tool_info: { name: tool, parameters },
  };
}

function fixtureSteps(name: string): Array<Record<string, any>> {
  const file = fileURLToPath(new URL(`../fixtures/agy/${name}.jsonl`, import.meta.url));
  const out: Array<Record<string, any>> = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const obj = JSON.parse(line);
    if (obj.event === "step_update" && obj.step_update) out.push(obj.step_update);
  }
  return out;
}

test("allowlist is frozen and has both naming sets", () => {
  assert.ok(Object.isFrozen(ANTIGRAVITY_TOOL_ALLOWLIST));
  for (const n of ["view_file", "read_file", "write_to_file", "write_file", "finish"]) {
    assert.ok(ANTIGRAVITY_TOOL_ALLOWLIST.includes(n), n);
  }
  assert.ok(!ANTIGRAVITY_TOOL_ALLOWLIST.includes("run_command"));
});

test("fixtures t1 and t3: only the plugin SKILL.md read is outside, as pluginRead", async () => {
  for (const [name, tree] of [
    ["t1", "H:\\agy-smoke-153\\t1"],
    ["t3", "H:\\agy-smoke-153\\t3"],
  ] as const) {
    const mon = winMonitor(tree, "C:\\Users\\user");
    let pluginReads = 0;
    for (const s of fixtureSteps(name)) {
      const d = await mon.check(s);
      assert.equal(d.allowed, true, `${name} step ${s.step_index} ${s.state}`);
      if (d.allowed && d.pluginRead) pluginReads++;
    }
    assert.ok(pluginReads >= 2, `${name} plugin reads (ACTIVE + DONE)`);
  }
});

test("fixture with a shell command is a violation", async () => {
  let violation: MonitorDecision | undefined;
  for (const name of ["t1", "t2", "t3", "t4", "t5"]) {
    const mon = winMonitor(`H:\\agy-smoke-153\\${name}`);
    for (const s of fixtureSteps(name)) {
      const d = await mon.check(s);
      if (!d.allowed && d.tool === "run_command") violation = d;
    }
  }
  assert.ok(violation, "a fixture contains run_command");
});

test("plugin SKILL.md read exception is narrow", async () => {
  const mon = winMonitor();
  const base = "C:\\Users\\user\\.gemini\\config\\plugins\\x";
  const ok = await mon.check(step("read_file", { Path: `${base}\\SKILL.md` }));
  assert.deepEqual(ok.allowed && ok.pluginRead, true);
  const ok2 = await mon.check(step("view_file", { AbsolutePath: `${base}\\skill.md` }));
  assert.equal(ok2.allowed && ok2.pluginRead, true);

  const other = await mon.check(step("read_file", { Path: `${base}\\other.md` }));
  assert.equal(other.allowed, false);
  const dotdot = await mon.check(
    step("read_file", { Path: "C:\\Users\\user\\.gemini\\config\\plugins\\x\\..\\..\\secret\\SKILL.md" }),
  );
  assert.equal(dotdot.allowed, false);
  const write = await mon.check(step("write_file", { Path: `${base}\\SKILL.md` }));
  assert.equal(write.allowed, false);
  const list = await mon.check(step("list_dir", { DirectoryPath: base }));
  assert.equal(list.allowed, false);
  const grep = await mon.check(step("grep_search", { SearchPath: `${base}\\SKILL.md`, Query: "x" }));
  assert.equal(grep.allowed, false);
  const replace = await mon.check(step("replace_file_content", { TargetFile: `${base}\\SKILL.md` }));
  assert.equal(replace.allowed, false);
  const folderItself = await mon.check(
    step("read_file", { Path: "C:\\Users\\user\\.gemini\\config\\plugins" }),
  );
  assert.equal(folderItself.allowed, false);
});

test("plugin SKILL.md exception is off without a home, and on other homes", async () => {
  const noHome = new ToolMonitor({ worktree: "/w", platform: "linux", realpath: identity });
  const d = await noHome.check(
    step("read_file", { Path: "/home/user/.gemini/config/plugins/x/SKILL.md" }),
  );
  assert.equal(d.allowed, false);
  const other = await posixMonitor("/w", "/home/user").check(
    step("read_file", { Path: "/home/other/.gemini/config/plugins/x/SKILL.md" }),
  );
  assert.equal(other.allowed, false);
});

test("plugin SKILL.md symlink pointing out of the plugins folder is denied", async () => {
  const link = "/home/user/.gemini/config/plugins/x/SKILL.md";
  const realpath = async (p: string) => (p === link ? "/etc/passwd" : p);
  const mon = new ToolMonitor({ worktree: "/w", home: "/home/user", platform: "linux", realpath });
  assert.equal((await mon.check(step("read_file", { Path: link }))).allowed, false);
  // A symlink named SKILL.md pointing to another file inside the plugins folder is denied too.
  const realpath2 = async (p: string) => (p === link ? "/home/user/.gemini/config/plugins/x/a.md" : p);
  const mon2 = new ToolMonitor({ worktree: "/w", home: "/home/user", platform: "linux", realpath: realpath2 });
  assert.equal((await mon2.check(step("read_file", { Path: link }))).allowed, false);
});

test("paths inside the worktree: forward slashes, relative, new files", async () => {
  const mon = winMonitor();
  const fwd = await mon.check(step("write_file", { Path: "H:/work/t1/src/new.txt" }));
  assert.equal(fwd.allowed, true);
  const rel = await mon.check(step("write_to_file", { TargetFile: "src\\a.txt" }));
  assert.equal(rel.allowed, true);
  const arr = await mon.check(step("multi_replace_file_content", { AbsolutePath: ["a.txt", "b/c.txt"] }));
  assert.equal(arr.allowed, true);
  assert.equal(arr.allowed && arr.paths.length, 2);
  const none = await mon.check(step("grep_search", { Query: "x" }));
  assert.equal(none.allowed, true);
  const fin = await mon.check(step("finish", {}));
  assert.equal(fin.allowed, true);
});

test("case handling: insensitive on win32, strict on linux", async () => {
  const win = await winMonitor("H:\\Work\\T1").check(step("read_file", { Path: "h:\\work\\t1\\a.txt" }));
  assert.equal(win.allowed, true);
  const lin = await posixMonitor("/Work/T1").check(step("read_file", { Path: "/work/t1/a.txt" }));
  assert.equal(lin.allowed, false);
});

test("escapes: relative .., absolute elsewhere, sibling prefix, other drive", async () => {
  const mon = winMonitor();
  assert.equal((await mon.check(step("read_file", { Path: "..\\x" }))).allowed, false);
  assert.equal((await mon.check(step("read_file", { Path: "../x" }))).allowed, false);
  assert.equal((await mon.check(step("read_file", { Path: "src/../../x" }))).allowed, false);
  assert.equal((await mon.check(step("read_file", { Path: "H:\\work\\t10\\a" }))).allowed, false);
  assert.equal((await mon.check(step("read_file", { Path: "C:\\Windows\\win.ini" }))).allowed, false);
  assert.equal((await mon.check(step("read_file", { Path: "\\\\server\\share\\a" }))).allowed, false);
  const d = await posixMonitor().check(step("read_file", { Path: "../x" }));
  assert.equal(d.allowed, false);
  assert.equal(!d.allowed && d.path, "../x");
});

test("unknown parameter shapes and path-like keys are checked", async () => {
  const mon = posixMonitor();
  assert.equal((await mon.check(step("read_file", { Path: 5 }))).allowed, false);
  assert.equal((await mon.check(step("read_file", { Path: "" }))).allowed, false);
  assert.equal((await mon.check(step("read_file", { Path: ["a", "/etc/passwd"] }))).allowed, false);
  assert.equal((await mon.check(step("read_file", { SomethingFile: "/etc/passwd" }))).allowed, false);
  assert.equal((await mon.check(step("read_file", { outputDirectory: "/etc" }))).allowed, false);
  assert.equal((await mon.check(step("read_file", { Path: "a\0b" }))).allowed, false);
  assert.equal((await mon.check({ ...step("read_file", {}), tool_info: { name: "write_file", parameters: {} } })).allowed, false);
});

test("disallowed tools are violations", async () => {
  const mon = posixMonitor();
  for (const tool of [
    "run_command",
    "invoke_subagent",
    "browser_subagent",
    "browser_input",
    "call_mcp_tool",
    "search_web",
    "read_url_content",
    "send_command_input",
    "sed_file",
    "totally_unknown",
    "",
  ]) {
    const d = await mon.check(step(tool, { CommandLine: "git status" }));
    assert.equal(d.allowed, false, tool);
  }
  const run = await mon.check(step("run_command", { CommandLine: "git status" }));
  assert.match(describeViolation(run), /run_command/);
  assert.equal((await mon.check(null)).allowed, false);
});

test("non-tool steps pass; state does not matter", async () => {
  const mon = posixMonitor();
  assert.equal((await mon.check({ step_index: 1, state: "DONE", step_type: "user_input" })).allowed, true);
  assert.equal((await mon.check({ step_type: "agent_response", text_delta: "hi" })).allowed, true);
  assert.equal((await mon.check(step("run_command", {}, "DONE"))).allowed, false);
  assert.equal((await mon.check(step("run_command", {}, "ACTIVE"))).allowed, false);
});

test("injected realpath resolving outside the worktree is a violation", async () => {
  const realpath = async (p: string) => (p === "/w/link/file.txt" ? "/outside/target/file.txt" : p);
  const mon = new ToolMonitor({ worktree: "/w", platform: "linux", realpath });
  assert.equal((await mon.check(step("read_file", { Path: "link/file.txt" }))).allowed, false);
  assert.equal((await mon.check(step("read_file", { Path: "ok/file.txt" }))).allowed, true);
});

test("realpath failure other than ENOENT is a violation", async () => {
  const realpath = async (p: string) => {
    if (p.includes("boom")) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return p;
  };
  const mon = new ToolMonitor({ worktree: "/w", platform: "linux", realpath });
  assert.equal((await mon.check(step("read_file", { Path: "boom/x" }))).allowed, false);
  const gone = new ToolMonitor({
    worktree: "/w",
    platform: "linux",
    realpath: async (p: string) => {
      if (p !== "/w") throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return p;
    },
  });
  assert.equal((await gone.check(step("write_file", { Path: "new/deep/f.txt" }))).allowed, true);
});

test("describeViolation names tool and path on one line", async () => {
  const d = await posixMonitor().check(step("write_file", { Path: "/etc/x\ny" }));
  const line = describeViolation(d);
  assert.ok(!line.includes("\n"));
  assert.match(line, /write_file/);
  assert.match(line, /\/etc\/x/);
  assert.equal(describeViolation({ allowed: true, tool: "x", paths: [] }), "");
});

test("stopOnViolation kills once only, and never for allowed steps", () => {
  let kills = 0;
  const kill = () => {
    kills++;
  };
  const bad: MonitorDecision = { allowed: false, tool: "run_command", reason: "tool not allowed" };
  assert.equal(stopOnViolation({ allowed: true, tool: "read_file", paths: [] }, kill), false);
  assert.equal(kills, 0);
  assert.equal(stopOnViolation(bad, kill), true);
  assert.equal(stopOnViolation(bad, kill), false);
  assert.equal(stopOnViolation({ ...bad, tool: "invoke_subagent" }, kill), false);
  assert.equal(kills, 1);
});

test("real filesystem: worktree, new files, symlink escape", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tool-monitor-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const work = path.join(base, "work");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(work, "src"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(work, "src", "a.txt"), "a");
  fs.writeFileSync(path.join(outside, "secret.txt"), "s");

  const mon = new ToolMonitor({ worktree: work });
  assert.equal((await mon.check(step("read_file", { Path: path.join(work, "src", "a.txt") }))).allowed, true);
  assert.equal((await mon.check(step("write_file", { Path: "src/new/deeper/f.txt" }))).allowed, true);
  assert.equal((await mon.check(step("read_file", { Path: path.join(outside, "secret.txt") }))).allowed, false);
  assert.equal((await mon.check(step("read_file", { Path: "../outside/secret.txt" }))).allowed, false);

  let linked = true;
  try {
    // "junction" is ignored on POSIX and needs no admin rights on Windows.
    fs.symlinkSync(outside, path.join(work, "escape"), "junction");
  } catch {
    linked = false;
  }
  if (!linked) {
    t.diagnostic("symlink/junction not permitted here; escape case skipped");
    return;
  }
  assert.equal((await mon.check(step("read_file", { Path: "escape/secret.txt" }))).allowed, false);
  assert.equal((await mon.check(step("write_file", { Path: "escape/new.txt" }))).allowed, false);

  // Dangling symlink whose target is outside the worktree (file symlink; may need privileges).
  try {
    fs.symlinkSync(path.join(outside, "missing.txt"), path.join(work, "dangling.txt"), "file");
    assert.equal((await mon.check(step("write_file", { Path: "dangling.txt" }))).allowed, false);
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err;
    t.diagnostic("file symlink not permitted here; dangling case skipped");
  }
});

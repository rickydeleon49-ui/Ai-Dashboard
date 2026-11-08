/**
 * Antigravity (AW.3) end to end: production build, desktop/SQLite server.
 *
 * No real agy, LM Studio or Claude calls. The server reads plugins and MCP
 * servers from os.homedir(), so HOME and USERPROFILE point at a throwaway
 * folder before the server starts.
 *
 * 1. Inventory endpoint returns names only; a run with Antigravity as the
 *    implementer needs a matching acknowledgement (409 with inventory, then 201).
 * 2. Antigravity event kinds (monitor_stop, plugin_read, continuation, denied
 *    action, advisor ok and not ok) come back through the events API and format
 *    to the expected run-page lines.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { Page } from "playwright";
import { eventPlainLines, parseEventData, type UiEvent } from "@/components/agents/runs/logic";
import {
  baseURL,
  e2eDatabasePath,
  newPage,
  start,
  stop,
} from "./helpers";

let seedPage: Page;
let projectId = "";
let fakeHome = "";
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

const SECRET = "SECRET_TOKEN_DO_NOT_LEAK";
const RUN_ID = "run_e2e_agy_events";

type Seed = { agent: string; kind: string; stage: string | null; payload: unknown };

const SEEDS: Seed[] = [
  { agent: "implementer", kind: "monitor_stop", stage: "implement", payload: { message: "edited a file outside scope" } },
  { agent: "implementer", kind: "plugin_read", stage: "implement", payload: { paths: ["alpha/skills/a.md", "alpha/skills/b.md"] } },
  { agent: "implementer", kind: "continuation", stage: "implement", payload: { stage: "implement", attempt: 2, of: 3 } },
  { agent: "implementer", kind: "warning", stage: "implement", payload: { deniedAction: "run_command", displayName: "Run shell command" } },
  { agent: "advisor", kind: "advisor", stage: "review", payload: { ok: true, model: "local-model", summary: "Looks fine" } },
  { agent: "advisor", kind: "advisor", stage: "review", payload: { ok: false, reason: "LM Studio is not running" } },
];

const EXPECTED = [
  "[implementer] STOPPED by tool monitor: edited a file outside scope",
  "[implementer] plugin file read (allowed): alpha/skills/a.md, alpha/skills/b.md",
  "== continuing Antigravity (implement, attempt 2 of 3)",
  "[implementer] denied: Run shell command",
  "[advisor] advisory only (local-model):",
  "  Looks fine",
  "[advisor] unavailable: LM Studio is not running",
];

before(async () => {
  fakeHome = mkdtempSync(path.join(tmpdir(), "cc-e2e-home-"));
  const gemini = path.join(fakeHome, ".gemini");
  mkdirSync(path.join(gemini, "config", "plugins", "alpha", "hooks"), { recursive: true });
  writeFileSync(path.join(gemini, "config", "plugins", "alpha", "hooks", "h.sh"), SECRET);
  mkdirSync(path.join(gemini, "config", "plugins", "beta"), { recursive: true });
  writeFileSync(path.join(gemini, "config", "plugins", "beta", "plugin.json"), JSON.stringify({ note: SECRET }));
  mkdirSync(path.join(gemini, "antigravity-cli", "mcp"), { recursive: true });
  writeFileSync(path.join(gemini, "antigravity-cli", "mcp", "files.json"), JSON.stringify({ token: SECRET }));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;

  await start();
  seedPage = await newPage();
  const res = await seedPage.request.post(`${baseURL}/api/projects`, {
    data: { source: "manual", type: "software", status: "active", name: "Antigravity e2e project" },
  });
  assert.equal(res.status(), 201, await res.text());
  projectId = ((await res.json()) as { project: { id: string } }).project.id;

  const db = new Database(e2eDatabasePath());
  try {
    db.prepare("UPDATE projects SET local_path = ? WHERE id = ?").run(process.cwd(), projectId);
    db.prepare(
      `INSERT INTO agent_run (id, project_id, status, stage, request, outcome, ended_at)
       VALUES (?, ?, 'succeeded', 'final', ?, ?, datetime('now'))`,
    ).run(
      RUN_ID,
      projectId,
      JSON.stringify({ projectId, task: "Antigravity events", checks: [], roles: { implementer: { provider: "antigravity" } } }),
      JSON.stringify({ status: "succeeded" }),
    );
    const insert = db.prepare(
      "INSERT INTO agent_run_event (run_id, seq, stage, agent, kind, payload) VALUES (?, ?, ?, ?, ?, ?)",
    );
    SEEDS.forEach((e, i) => insert.run(RUN_ID, i + 1, e.stage, e.agent, e.kind, JSON.stringify(e.payload)));
  } finally {
    db.close();
  }
});

after(async () => {
  await stop();
  for (const [k, v] of Object.entries(savedHome)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(fakeHome, { recursive: true, force: true });
});

function runBody(ack?: { plugins: string[]; mcpServers: string[] }) {
  return {
    projectId,
    task: "Antigravity acknowledgement e2e",
    roles: { implementer: { provider: "antigravity" } },
    checks: [],
    ...(ack ? { antigravityAcknowledgement: ack } : {}),
  };
}

describe("antigravity (e2e)", () => {
  it("inventory endpoint returns names only", async () => {
    const res = await seedPage.request.get(`${baseURL}/api/agent-runs/antigravity-inventory`);
    assert.equal(res.status(), 200);
    const text = await res.text();
    assert.ok(!text.includes(SECRET), "file contents must not leak");
    const body = JSON.parse(text) as {
      plugins: { name: string; hasHooks: boolean }[];
      mcpServers: string[];
    };
    assert.deepEqual(body.plugins, [
      { name: "alpha", hasHooks: true },
      { name: "beta", hasHooks: false },
    ]);
    assert.deepEqual(body.mcpServers, ["files"]);
  });

  it("run without acknowledgement is 409 with inventory; mismatch is 409; matching is accepted", async () => {
    const none = await seedPage.request.post(`${baseURL}/api/agent-runs`, { data: runBody() });
    assert.equal(none.status(), 409, await none.text());
    const noneBody = (await none.json()) as {
      error: string;
      inventory: { plugins: { name: string }[]; mcpServers: string[] };
    };
    assert.match(noneBody.error, /acknowledge/i);
    assert.deepEqual(noneBody.inventory.plugins.map((p) => p.name), ["alpha", "beta"]);
    assert.deepEqual(noneBody.inventory.mcpServers, ["files"]);

    const stale = await seedPage.request.post(`${baseURL}/api/agent-runs`, {
      data: runBody({ plugins: ["alpha"], mcpServers: ["files"] }),
    });
    assert.equal(stale.status(), 409, await stale.text());
    assert.match(((await stale.json()) as { error: string }).error, /changed/i);

    const ok = await seedPage.request.post(`${baseURL}/api/agent-runs`, {
      data: runBody({ plugins: ["beta", "alpha"], mcpServers: ["files"] }),
    });
    assert.equal(ok.status(), 201, await ok.text());
    const run = ((await ok.json()) as { run: { id: string } }).run;
    assert.ok(run.id);
  });

  it("Antigravity events come back through the events API and format to run-page lines", async () => {
    const res = await seedPage.request.get(`${baseURL}/api/agent-runs/${RUN_ID}/events`);
    assert.equal(res.status(), 200);
    const events: UiEvent[] = [];
    for (const block of (await res.text()).split("\n\n")) {
      if (!block.includes("event: agent-event")) continue;
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      const ev = data ? parseEventData(data.slice("data: ".length)) : null;
      if (ev) events.push(ev);
    }
    assert.deepEqual(events.map((e) => e.kind), SEEDS.map((s) => s.kind));
    assert.deepEqual(events.flatMap(eventPlainLines), EXPECTED);
  });

  it("run page renders the Antigravity event lines", async () => {
    const p = await newPage();
    await p.goto(`/agents/runs/${RUN_ID}`, { waitUntil: "domcontentloaded" });
    await p.getByText("STOPPED by tool monitor: edited a file outside scope").first().waitFor({ state: "attached" });
    const text = (await p.locator("body").textContent()) ?? "";
    for (const line of EXPECTED.map((l) => l.trim())) {
      assert.ok(text.includes(line), `page shows: ${line}`);
    }
    await p.context().close();
  });
});

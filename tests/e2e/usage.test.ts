/**
 * /usage page: genuine browser interaction (Chromium, production build,
 * desktop/SQLite server).
 *
 * The usage folder is pointed at a throwaway fixture folder with small tracker
 * CSVs (PATCH /api/usage); the app's own usage is seeded straight into the
 * throwaway database.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { Page } from "playwright";
import { e2eDatabasePath, newPage, pageErrors, start, stop } from "./helpers";

let page: Page;
let fixture = "";
let emptyFolder = "";

/** Today's date in the time zone the usage page uses (America/Los_Angeles). */
function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function write(rel: string, text: string): void {
  const file = path.join(fixture, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

async function setFolder(folder: string): Promise<number> {
  const res = await page.request.patch("/api/usage", { data: { folder } });
  return res.status();
}

before(async () => {
  await start();
  fixture = mkdtempSync(path.join(tmpdir(), "cc-usage-fixture-"));
  emptyFolder = mkdtempSync(path.join(tmpdir(), "cc-usage-empty-"));

  const day = today();
  const nowIso = new Date().toISOString();
  const inThreeHours = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const inThreeDays = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();

  write(
    "claude-code-usage-daily.csv",
    "machine,date,model,total,replies,cost_usd\n" + `mac,${day},claude-opus-test,1500000,12,7.5\n`,
  );
  write(
    "codex-usage-daily.csv",
    "date,model,input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,responses\n" +
      `${day},gpt-test-sol,1,1,1,1,700000,7\n`,
  );
  write(
    "tools/windows-pc-antigravity-daily.csv",
    "machine,date,model,total,replies\n" + `windows-pc,${day},agy-cli,300000,3\n`,
  );
  write(
    "tools/windows-pc-codex-limits.csv",
    "snapshot_at,five_hour_used_pct,five_hour_window_min,five_hour_resets_at,weekly_used_pct,weekly_window_min,weekly_resets_at\n" +
      `${nowIso},42,300,${inThreeHours},17,10080,${inThreeDays}\n`,
  );

  page = await newPage();
  // The first request creates and migrates the database; only then can it be seeded.
  await page.goto("/");

  const db = new Database(e2eDatabasePath());
  try {
    db.prepare("INSERT INTO ai_conversations (id, provider, mode) VALUES ('conv_usage', 'local', 'chat')").run();
    const msg = db.prepare(
      "INSERT INTO ai_messages (id, conversation_id, role, model, prompt_tokens, completion_tokens, created_at) VALUES (?, 'conv_usage', 'assistant', 'qwen-usage-test', ?, ?, ?)",
    );
    msg.run("msg_usage_1", 100, 50, nowIso);
    msg.run("msg_usage_2", null, null, nowIso);
    db.prepare("INSERT INTO projects (id, name) VALUES ('proj_usage', 'Usage e2e')").run();
    db.prepare("INSERT INTO agent_run (id, project_id) VALUES ('run_usage', 'proj_usage')").run();
    db.prepare(
      "INSERT INTO agent_run_event (run_id, seq, ts, stage, agent, kind, payload) VALUES ('run_usage', 1, ?, 'final', 'advisor', 'advisor', ?)",
    ).run(nowIso, JSON.stringify({ ok: false, reason: "advisor timed out" }));
  } finally {
    db.close();
  }

  assert.equal(await setFolder(fixture), 200);
});

after(async () => {
  await stop();
  for (const dir of [fixture, emptyFolder]) {
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

describe("/usage", () => {
  it("shows the three tool cards, the Codex bars and the app card", async () => {
    await page.goto("/usage");

    await page.locator('[aria-label="Claude Code usage"]').waitFor();
    await page.locator('[aria-label="Codex usage"]').waitFor();
    await page.locator('[aria-label="Antigravity usage"]').waitFor();

    const claude = page.locator('[aria-label="Claude Code usage"]');
    assert.match(await claude.innerText(), /1\.5 M tokens/);
    assert.match(await claude.innerText(), /\$7\.50/);

    const fiveHour = page.getByRole("progressbar", { name: "Codex 5-hour limit used" });
    const weekly = page.getByRole("progressbar", { name: "Codex Weekly limit used" });
    assert.equal(await fiveHour.getAttribute("aria-valuenow"), "42");
    assert.equal(await weekly.getAttribute("aria-valuenow"), "17");

    const app = page.locator('[aria-label="This app usage"]');
    await app.waitFor();
    const text = await app.innerText();
    assert.match(text, /Ollama \(local\)/);
    assert.match(text, /2 replies today/);
    assert.match(text, /1 without counts/);
    assert.match(text, /qwen-usage-test/);
    assert.match(text, /LM Studio advisor/);
    assert.match(text, /1 failed/);

    assert.deepEqual(pageErrors(page), []);
  });

  it("lists Usage in the sidebar", async () => {
    await page.goto("/usage");
    const link = page.getByRole("link", { name: /^Usage/ }).first();
    await link.waitFor();
    assert.equal(new URL(await link.evaluate((a) => (a as HTMLAnchorElement).href)).pathname, "/usage");
  });

  it("rejects a relative folder with 400", async () => {
    assert.equal(await setFolder("relative/dir"), 400);

    await page.goto("/usage");
    await page.getByRole("button", { name: "Change" }).click();
    await page.getByLabel("Usage folder (absolute path)").fill("relative/dir");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByText("Folder must be an absolute path.").waitFor();
  });

  it("shows the empty state for an empty folder", async () => {
    assert.equal(await setFolder(emptyFolder), 200);
    await page.goto("/usage");
    await page.getByText("No usage data yet").waitFor();
    assert.equal(await page.locator('[aria-label="Claude Code usage"]').count(), 0);
    assert.deepEqual(pageErrors(page), []);
  });
});

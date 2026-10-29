# AW.1 in rounds

How the AW.1 build list (`AW-agent-workflow-control-center.md` §15) is built,
one round at a time, under the workflow in `AGENTS.md`. The design note stays
the source of truth for *what* each step does; this file only fixes the order,
the grouping, who builds each slice, and which PR it ships in.

Written October 28, 2026.

## Ground rules for every slice

- Code lives in `src/core/agents/` (as the design note says), routes in
  `src/app/api/agent-runs/`, pages in `src/app/agents/` and
  `src/app/settings/agents/`, tests in `tests/unit/agent-*.test.ts`.
- **SQLite only.** The agent tables are desktop-only (§4), so there is no
  `schema.pg.ts` change and no `drizzle-pg/` migration.
- **Only the runner spawns agents.** API routes record intents and stream
  events; they never call `child_process` (§2.3).
- Every route returns **404** unless `isAgentRunsEnabled()` is true (§2.2).
- No real agent CLI, token or network in any test: the fake agent
  (`tests/fixtures/fake-agent.mjs`) stands in for Claude Code.
- Each slice brings the tests from §12 that cover it. A slice is done when
  `gates.sh <round> quick` is green (plus `full` or `desktop` where marked),
  every new guard passes a mutation check, and the review is answered.

## Who builds what

Builders are Claude and Antigravity only (see `AGENTS.md`). Claude may hand a
slice to a Sonnet subagent; Haiku does mechanical work such as docs and log
triage. The builder is chosen by risk, not size:

- **Claude (Sonnet subagent)**: security- or Windows-sensitive slices.
  Antigravity reviews them read-only.
- **Claude (main session)**: the orchestrator. It decides what "succeeded"
  means, so it stays with the reviewer that answers for it.
- **Antigravity (Gemini 3.8 Flash Medium)**: well-specified slices with a
  clear file list. Claude reviews them.

## Slices

| Slice | §15 steps | What | Builder | Size | Depends on | PR |
|---|---|---|---|---|---|---|
| AW1-01 | 1, 3 | `types.ts`, `schema.ts` (statuses, stages, event kinds, Zod request/plan/review schemas); `availability.ts` (`isAgentRunsEnabled()`, built on `src/lib/auth-mode.ts`) | Antigravity | S | — | A |
| AW1-02 | 5 | `redact.ts`: tokens, auth headers, env secrets; pure and exhaustively tested | Sonnet | S | — | A |
| AW1-03 | 2, 4 | The five tables in `src/db/schema.ts` + generated SQLite migration; `events.ts` (gapless `seq` in a transaction, bounded and redacted payload, `readSince`) | Antigravity | M | 01, 02 | A |
| AW1-04 | 6 (part) | `roots.ts`: workspace roots, worktree root and run storage as per-machine settings; realpath containment; drive-missing check; workspace locks | Sonnet | M | 03 | B |
| AW1-05 | 6 (rest) | `workspace.ts`: worktree create/remove inside Command Center's own folder only, a runner-authored commit after each stage, `git diff base...HEAD` summary with the review-ordered changed-files list | Antigravity | M | 04 | B |
| AW1-06 | 7 | `process.ts`, `resolve-executable.ts`: `shell: false` from a resolved path (no `.cmd` shims), PID and group recorded, Stop via SIGTERM→SIGKILL (macOS) or `taskkill /T` then `/T /F` (Windows), output through `src/core/ai/ndjson.ts` | Sonnet | M | 01 | B |
| AW1-07 | 8, 14 (part) | `adapters/claude-code.ts` (`probe`, `buildArgv` asserted to never contain a bypass flag, per-run `--settings` grant file, stream-json → events), `adapters/fake.ts`, `tests/fixtures/fake-agent.mjs` | Antigravity | M | 03, 06 | C |
| AW1-08 | 9 | `orchestrator.ts`: the §7 stage machine with a single-pass review; final status only from facts the runner observed | Claude | L | 05, 07 | C |
| AW1-09 | 10 | `runner/index.ts` + `npm run runner`: claims intents, runs the orchestrator, epoch-based recovery at startup, worktree recovery report (report only) | Sonnet | M | 08 | C |
| AW1-10 | 11 | `desktop/main.js`: fork the runner beside the server, pass the run-storage path, stop it on quit. **Gates: `desktop`** | Antigravity | S | 09 | C |
| AW1-11 | 12 | `src/app/api/agent-runs/**`: start/stop intents, run read, SSE events with `Last-Event-ID` replay; 404 when disabled | Antigravity | M | 03 | D |
| AW1-12 | 13 (part) | Settings: provider probes, workspace roots, worktree root; navigation entry (desktop only) | Antigravity | M | 04, 11 | D |
| AW1-13 | 13 (rest) | Run form, history, run detail (timeline, events, checks, verdict, Stop, diff view). **Gates: `full`** | Antigravity | L | 11, 12 | D |
| AW1-14 | 15, 16 | `scripts/agents-demo.ts` + `npm run agents:demo` (synthetic project, temp DB, fake agent); README and design-note results | Antigravity (script), Haiku (docs) | S | all | E |

**Parallel starts:** AW1-01, AW1-02 and AW1-06 share no files and can run at
once. AW1-11 can start as soon as AW1-03 merges, alongside batch C.

**PR batches** (to save CI minutes): **A** foundation (01–03), **B** workspace
and process (04–06), **C** agents and runner (07–10), **D** API and UI (11–13),
**E** demo and docs (14). Each batch merges before the next one starts.

## Open items

- **`diff2html`** (§10A) is a new dependency. `CLAUDE.md` needs the owner's
  agreement before it is added. Until then, AW1-13 shows the plain unified diff
  from AW1-05 in a `<pre>` block.
- **§14 kickoff:** Claude Code `--help` is still to be captured on the Mac.
  The Windows PC has 2.1.312. AW1-07 records the flags it relies on from the
  Windows help output and probes them at run time, so this doesn't block it.
- **`flight-deck-team`** (§10) is on the Mac. It informs AW1-08 and AW1-09 but
  doesn't block them.
- **Acceptance for AW.1** (§16.1) still needs one real Claude Code run on a
  scratch project on the Windows PC and one on the Mac, after batch E.

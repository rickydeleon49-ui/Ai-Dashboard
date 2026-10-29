# Design Note: Agent Workflow Control Center

**Status:** Approved as the product direction (October 12, 2026). AW.1 is next. No code yet.

**Updated:** October 12, 2026

**Context:** A request to add a general-purpose control center that runs and
monitors coordinated coding agents (planner → implementer → checks → reviewer →
corrections) against any local project. This note reviews that request against
the existing architecture, records the decisions it needs, and splits it into
releases that can each be reviewed on their own.

---

## 1. Verdict

**Worth building, and the codebase is a good fit for it, but not as one change.**

The request is about six features in one: a project registry, a durable
orchestrator, three CLI adapters, a sandbox and permission model, a live event
stream, and a review UI. Built as one change, it would produce a diff that
nobody can review independently. That defeats the request's own last line.

The dashboard already has most of the groundwork this needs:

| Need | What already exists |
| --- | --- |
| Local project folders | `projects.local_path` and the desktop `desktop:open-local` IPC (folder, editor, terminal) |
| An approval vocabulary | `src/core/ai/approvals.ts`: `auto` / `ask` / `never` per action, with `git_push` defaulting to `never` |
| Streamed JSON parsing | `src/core/ai/ndjson.ts`, which handles chunk boundaries and is fully tested. Claude Code `--output-format stream-json` emits exactly this format. |
| Supervising a child process | `desktop/ollama.js` (spawn, health, shutdown) and the Electron main process forking the server |
| Localhost binding and protection against requests from other sites | `src/proxy.ts`, with a per-launch `DESKTOP_INTERNAL_SECRET` and cross-site checks on state-changing requests |
| Restart-tolerant background work | `src/core/automation/scheduler.ts` (a `globalThis` singleton that recomputes from the database, not from timers) |
| Design language | `PageHeader`, `Card`, `Badge`, `EmptyState` and the design tokens in `globals.css` |

So this extends the codebase; nothing needs to be invented from scratch. The
rest of this note covers the parts that are genuinely new and risky.

## 2. Decisions (all made on October 12, 2026)

### 2.1 It conflicts with the current product direction, so decide deliberately

`NEXT.md` says the app is *"a personal command center, not an AI agent
platform"*, and that *"automation is a later product, not a sidebar page"*, because
reliable jobs need logs, retries, cancellation, permissions, secrets and failure
recovery. This feature is exactly that subsystem.

There are two honest ways forward:

- **(Recommended) Build it as that "later product", on purpose.** Give it its own
  top-level section ("Agent Runs"), mark it desktop-only, and accept that it
  comes with the logs, cancellation, recovery and permission work listed above.
  This note plans for all of it.
- Defer it and keep the dashboard smaller.

Either is reasonable. Building it as a half-finished sidebar page is the one
option the existing rules rule out.

**Decision (October 12, 2026): confirmed.** The control center is now the
product. It ships desktop-first, and the plan goes ahead as written, including
the separate runner process in §2.3. `NEXT.md` has been updated to match.

### 2.2 Desktop-only, and it fails closed everywhere else

A server that launches CLI processes against a filesystem path amounts to remote
code execution if anyone else can reach it. The feature must be **disabled
unless the server runs in desktop local mode** (`DASHBOARD_LOCAL=1` with
`DESKTOP_INTERNAL_SECRET`, bound to 127.0.0.1):

- In hosted single-password mode and accounts mode (Railway), the routes return
  404 and the navigation entry is hidden.
- This is checked in `core/`, not only in the UI. The same pattern as
  `isAccountsMode()`.

#### Later: self-hosting on your own machine (for example, a mini PC)

Running the control center on an always-on machine you own is a likely next
step. It would also remove the "only runs while the app is open" limitation in
§13. It is a **new, separate mode**, not a relaxation of the rule above, because
the server would be reachable from other devices. It needs its own release
(AW.5) with at least these requirements:

- An explicit opt-in mode (for example, `AGENT_HOST_MODE=self-hosted`) that refuses
  to start alongside `AUTH_MODE=accounts`, `DATABASE_URL` or a Railway environment.
- Real operator authentication for every request, including the event stream.
  The desktop secret is per-launch and local, so it cannot be reused for this.
- Bind to a private interface only (the LAN address or a Tailscale/WireGuard
  address), never `0.0.0.0` on a public network, and use TLS when reached over
  the network.
- Projects and run storage live on that machine. The browser never sends paths
  outside its registered projects, just as on desktop.

The architecture already allows for this. The runner is its own process, and
state lives in SQLite, so it can run headless on the mini PC beside a
`next start` server without Electron. AW.1–AW.4 stay desktop-only, and nothing
in them may assume Electron is present apart from the fork in `desktop/main.js`.

### 2.3 Where the processes live: a dedicated runner, not the Next.js server

Long-lived child processes do not belong inside Next.js route handlers.
Development hot-reload, worker recycling and request timeouts all orphan or kill
them. **Recommendation:** add a separate **agent runner** Node process, forked by
the Electron main process alongside the server:

```
Electron main
  ├─ fork() Next standalone server   (UI + API; never spawns agents)
  └─ fork() agent runner             (owns every agent child process)
          ▲
          │ SQLite (WAL): run requests, stop requests, events
          ▼
  Next API ── SSE ──► browser
```

- The Next API **only writes intents** (create a run, stop a run, approve an
  action) as rows. It never spawns anything. That makes "structured workflow
  actions, not shell commands" true by construction: there is no code path from
  an HTTP body to `spawn`.
- The runner claims intents, owns the process groups, and appends events.
- SQLite is the single source of truth. That gives restart recovery and
  reconnection without a second protocol.
- In `npm run dev` (web, no Electron), the runner starts as a separate
  `npm run runner` script. The UI shows "Runner not running" rather than
  pretending.

## 3. Things in the request I could not verify here

| Item | Status | Consequence |
| --- | --- | --- |
| Claude Code CLI | **Verified** (v2.1.296): `-p`, `--output-format stream-json`, `--model`, `--effort`, `--permission-mode`, `--allowedTools`, `--disallowedTools`, `--add-dir`, `--resume`, `--settings` | The implementer adapter can be built and tested now |
| Codex CLI | **Version 0.160.0 (Mac) and 0.162.1 (Windows, signed in with ChatGPT). Help output verified** (`codex exec --help`, from your Mac): `--json`, `--output-schema`, `-o`, `-m`, `-c`, `-s read-only/workspace-write`, `-C`, `--ignore-user-config`, `exec resume` | Adapter flags are settled. See §3.1. `codex login status` works ("Logged in using ChatGPT"). The effort config key still needs confirming. |
| Antigravity (`agy`) | **Version 1.3.3. Help output verified** (Windows PC): `-p/--print`, `--output-format stream-json`, `--input-format stream-json`, `--model`, `--effort low…max`, `--mode accept-edits\|plan`, `--sandbox`, `--json-schema`, `--print-timeout`, `--conversation`, and an `agy models` listing | **Headless mode exists**, which resolves the biggest unknown. See §3.2. The model ID, sign-in check and shell-permission behaviour still need verifying. |
| Model IDs "GPT-6.1 Sol", "Gemini 3.8 Flash High" | Unverified | These are stored as configured strings, validated against each CLI's own model listing where one exists, and **never substituted**. A rejected model fails the run with the CLI's own error message. |
| Opus 5.5 | `claude-opus-5-5`, passed via `--model`, with `--effort medium` | — |
| LM Studio + Gemma 4 12B | Not available here | Optional advisory adapter for LM Studio's OpenAI-compatible endpoint, default `127.0.0.1:1234`. It summarises only and never gates success. |
| `flight-deck-team` controller | **Not reachable.** It is on your Mac (`/Users/rickymac/...`); this is a cloud container | See §10 for what to bring over |

**Provider availability is a probe, not a setting.** Each adapter has a
`probe()` that runs `--version` and an auth-status command, then reports
installed, version, authenticated (yes/no) and supported models. A provider
that fails its probe cannot be selected. The probe never reads, copies or
displays credential files (`~/.claude`, `~/.codex`, keychains). It reports only
the yes/no answer the CLI itself gives.

### 3.1 Codex adapter (codex-cli 0.160.0, from `codex exec --help` on the development Mac, October 12, 2026)

`codex exec` is a real non-interactive mode, so Codex can serve as planner and
reviewer without a person at the keyboard. These are the flags the adapter will
use and the ones it refuses.

**Used:**

| Flag | Purpose |
| --- | --- |
| `codex exec [PROMPT]`, with the prompt on **stdin** (`-`) | Long plans and diffs never go on the command line, where they would be visible in `ps` and limited in length |
| `--json` | JSONL events on stdout, parsed with the existing `ndjson.ts` and mapped to run events |
| `--output-schema <file>` | **The key flag.** The planner and reviewer must return JSON matching a schema the runner writes into run storage. This replaces "parse the agent's prose" with validation, which the truthful-status rule in §7 depends on. |
| `-o, --output-last-message <file>` | The final message is written to a file in run storage. The runner validates it again with Zod and does not trust stdout alone. |
| `-m, --model <MODEL>` | The configured model ("GPT-6.1 Sol" by default), passed through exactly. A rejected model fails the run with Codex's own error. |
| `-c model_reasoning_effort="<level>"` | Effort. **Verified (October 12, 2026, Mac, 0.160.0):** the value is checked by the service. `"medium"` ran normally, and `"banana"` was rejected with HTTP 400: *"Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'."* The dashboard also validates against that list **before** spawning, so a typo never costs a turn. Default: `medium`. |
| `-s, --sandbox read-only` | **Planner and reviewer.** They read the worktree and never write to it. The runner computes the diff and runs the checks itself, so the reviewer needs no write access. |
| `-s, --sandbox workspace-write` | Only if Codex is ever used as an *implementer* (not in the current plan) |
| `-C, --cd <worktree>` | The working root is always the run's worktree, never your original folder |
| `--ignore-user-config` + explicit `-c` values | A `sandbox_mode` or approval default in your `~/.codex/config.toml` cannot quietly widen a run's permissions. Authentication still comes from `CODEX_HOME`. The dashboard never reads it. |
| `codex exec resume <id>` | AW.4 resume, using the session ID recorded from the JSON events |

**Refused** (in the argv denylist and asserted by adapter tests):

- `--dangerously-bypass-approvals-and-sandbox` and `-s danger-full-access`. These are bypass flags and are never used unattended.
- `--dangerously-bypass-hook-trust`.
- `--approve-for-me`. It routes approval requests to automatic review, which amounts to unattended self-approval. Approvals in this product come from you (§6.3).
- `--ignore-rules`. Your execpolicy rules can only narrow what Codex does, so they stay loaded.

**Not used, and why:**

- `--worktree`. The runner manages its own worktrees (§5), so lock, cleanup and diff behaviour are the same for every provider.
- `codex exec review`. It is attractive, but it reviews the repository on its own terms. The reviewer must judge *the runner's* diff and check results, and that needs the structured prompt and output schema above. It is worth revisiting as an extra opinion later.
- `--skip-git-repo-check`. It is never needed, because non-Git projects are turned into a Git snapshot first (§5).
- `--ephemeral`. Sessions are kept so a run can be resumed, and the dashboard records only the session ID.
- `--oss` and `--local-provider lmstudio`. These could point Codex at LM Studio, but the local advisor (Gemma) stays a separate adapter and never acts as a planner or reviewer by accident.

**Still needed from the Mac** (for the probe):

- ~~`codex --version`~~ **Done**: codex-cli 0.160.0. The probe records the version and warns when it changes, because flags move between releases.
- ~~The login-status command~~ **Done**: `codex login status` prints "Logged in using ChatGPT" (Windows, 0.162.1). The probe reports signed in yes/no from it without reading `~/.codex`.
- ~~The effort key~~ **Done**: see the `-c model_reasoning_effort` row above.

**Codex `--json` event shape** (Mac, 0.160.0), which the adapter and the fake-agent fixture copy:

- `{"type":"thread.started","thread_id":…}`. The thread ID is recorded for AW.4 resume (`codex exec resume <id>`).
- `{"type":"turn.started"}`
- `{"type":"item.completed","item":{"id","type":"agent_message","text"}}`
- `{"type":"turn.completed","usage":{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}}`. Usage per turn feeds the cost readout.
- On failure: `{"type":"error","message":…}` then `{"type":"turn.failed","error":{"message":…}}`. **The `message` holds a second JSON document encoded as a string** (the service's error body), so the adapter parses it a second time to show the real reason ("Invalid value 'banana'…") instead of an escaped blob.
- A trivial "reply OK" turn used about 19,000 input tokens (13,000 of them cached).

### 3.2 Antigravity adapter (`agy` 1.3.3, from `agy --help` on the Windows PC, October 12, 2026)

**Antigravity has a real headless mode**, so it can be the unattended
implementer the request asks for. `agy` is a native executable
(`%LOCALAPPDATA%\agy\bin\agy.exe` on Windows), so it needs no `.cmd`
resolution (§5A). One third-party guide claimed it has no `--model` flag. That
was wrong: the help output lists one.

**Used:**

| Flag | Purpose |
| --- | --- |
| `-p, --print` | Runs one turn non-interactively and exits |
| `--output-format stream-json` | Live events for the run log, parsed with `ndjson.ts`. (`json` is the fallback if stream-json turns out to be partial.) |
| `--input-format stream-json` | Sends the prompt (and the correction-round findings) as NDJSON on **stdin** rather than on the command line. It requires `--output-format stream-json`. |
| `--model <id>` | The configured model ("Gemini 3.8 Flash High" by default). Its exact ID is validated against **`agy models`**, which lists the available models, before the run starts. An unlisted model fails the run and is never substituted. |
| `--effort high` | Effort, from the documented `low\|medium\|high\|xhigh\|max`. This flag is supported directly, unlike Codex's config key. |
| `--mode accept-edits` | **Implementer.** Edits are accepted without prompting, which the request asks for inside the run's worktree. This is narrower than skipping all permissions. |
| ~~`--mode plan`~~ | **Not used.** Smoke test 1 showed that plan mode still runs shell commands (see below). Antigravity is implementer-only. |
| `--sandbox` | "Terminal restrictions enabled". Always on. |
| `--json-schema <file>` | Structured final output (applies to the final result in stream-json), the same way as Codex's `--output-schema` |
| `--print-timeout <dur>` | Default `0s`, which waits until the turn completes. The runner sets an explicit per-stage limit, so a hung turn ends as `failed: timed out` instead of hanging forever. The "30-second timeout" in a community wrapper was that wrapper's own setting. |
| `--disable-slash-commands` | Text in a task, or in a reviewer finding, cannot trigger a slash command or skill expansion in print mode |
| `--conversation <id>` | AW.4 resume, using the conversation ID recorded from the events |
| `--add-dir` | **Not used** by default. The working directory is the run's worktree (set through the spawn `cwd`), and nothing else is added. |

**Refused** (in the argv denylist and asserted by adapter tests):

- `--dangerously-skip-permissions`, which auto-approves every tool request.
- `--remote-control` and the `remote-control` / `mic-serve` subcommands, because they expose the session to another host.
- `-c` / `--continue`. It resumes "the most recent conversation", which may not be this run's. Resume always uses an explicit `--conversation <id>`.
- `--prompt-interactive` / `-i`, which is interactive and has no place in an unattended run.
- `install` and `update` while a run is active, because they would change the CLI underneath it.

**Still to verify, with a smoke test in a scratch Git repository:**

1. ~~**`agy models`**~~ **Done** (October 12, 2026, Windows): the default is the model ID **`gemini-3.8-flash-high`** ("Gemini 3.8 Flash (High)"). "High" is part of the **model ID**, a fixed reasoning tier (`-low`, `-medium` and `-high` variants exist), not the `--effort` flag. The adapter therefore treats them as two settings: the model ID exactly as listed, and `--effort` separately (default `high`). The settings page shows both, so neither is ever silently derived from the other. The listing also offers `claude-*` and `gpt-oss-*` models through Antigravity. Picking one runs *Antigravity*, not Claude Code or Codex, and the run is labelled by provider **and** model, so the two are never confused. The listing output starts with an ANSI escape sequence (`ESC[K`), so the probe strips terminal control codes before parsing it.
2. **Sign-in status.** The help lists no `login` or `status` command, so the probe needs a cheap way to report "signed in: yes/no", for example a minimal `-p` turn that fails in a recognisable way when signed out.
3. ~~**What happens under `accept-edits` when a turn needs a shell command**~~ **Done** (smoke test 3): it is auto-denied, reported in `result.denied_actions`, and does not hang. The implementer gets no shell; the runner runs the checks.
4. **What `--project` / `--new-project` do.** Antigravity has its own project concept. The adapter must not create or change Antigravity projects as a side effect, unless that turns out to be how a working directory is chosen.
5. ~~**The stream-json event shape**~~ **Done** (smoke test 1, below). It is the shape, which the event mapping and the fake agent fixture are built from.

#### Smoke test 1 results (Windows, `agy` 1.3.3, October 12, 2026)

Command: `agy -p "Reply with the single word OK." --output-format stream-json --mode plan --sandbox --print-timeout 120s`, run in a scratch Git repository on `H:`.

- **Event shape.** First `{"event":"init", conversation_id, init:{cwd, tools[], permission_mode, expanded_commands}}`. Then `{"event":"step_update", step_update:{conversation_id, step_index, state: ACTIVE|DONE|ERROR, step_type: user_input|agent_response|tool|unknown, tool_name?, tool_info?{name, parameters}, text_delta?, duration_seconds?, usage?{input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}, error?{type, message}}}`. Finally `{"event":"result", result:{conversation_id, status, response, duration_seconds, num_turns, usage}}`. These map one-to-one onto run events, and the fake-agent fixture copies this shape.
- **Being signed in shows up as a successful turn.** That works as a sign-in check, but it is expensive: this trivial turn used **about 29,000 tokens and took 50 seconds**, mostly system prompt. The probe therefore caches the result and runs it only when you press "Check sign-in", never on page load.
- **`result.status` said `SUCCESS` although a step ended in `ERROR`.** This confirms §7: the runner records every `ERROR` step and never takes the CLI's own status as the outcome.
- **Your plugins and hooks load in headless runs.** A `PreToolUse` hook from a user plugin (`googlecloudtools.datacloud_telemetry`, under `%USERPROFILE%\.gemini\config\plugins`) ran on the tool call, crashed because its bundle file was missing, and failed the call. Three consequences:
  1. Runs depend on whatever plugins happen to be installed on that machine. This is the same problem Codex's `--ignore-user-config` solves, but the `agy` help lists no equivalent flag.
  2. A third-party hook sees every tool call the agent makes, including file contents and commands. That is not acceptable for unattended runs without your knowledge.
  3. **Rule:** before each run, the probe lists the installed plugins and hooks (`agy plugin list`). If any are enabled, the run form shows them and requires an explicit acknowledgement, until a way to run `agy` with an isolated config home is found and verified. Under the "never silently" rule, the dashboard also never disables your plugins for you.
- **`--mode plan` is not read-only.** It issued a `run_command` (`Get-ChildItem -Force`) and reported `permission_mode: "request-review"`. Antigravity therefore stays **implementer-only**. Planner and reviewer roles need a CLI with a verified read-only mode (Codex `-s read-only`, or Claude Code with write tools disallowed).
- **The tool surface is broad and cannot be narrowed from the command line.** The `init.tools` list includes browser control (`browser_*`, `execute_browser_javascript`), `search_web`, `read_url_content`, `call_mcp_tool`, `send_message`, `schedule`, `manage_inbox`, `run_workflow` and `generate_image`. Unlike Claude Code, `agy` has no `--allowedTools` / `--disallowedTools` flag. The mitigations are a custom `--agent` with a restricted toolset, if `agy agents` supports defining one (to verify), or recording every tool call and failing the run when a tool outside an allowlist was used. A tool that can reach the network is shown to you as such.
- **Usage is reported for every step**, so a per-run token readout costs nothing extra to add (§13, cost).

#### Smoke test 2 results (Windows, `agy` 1.3.3, October 12, 2026): inconclusive, with three new findings

Command: `agy -p "Create a file named hello.txt containing hi, then run the command: git status" --output-format stream-json --mode accept-edits --sandbox --print-timeout 180s`. It took 116 seconds, about 16,000 tokens plus 122,000 cached.

- **The question was not answered.** Every tool call (`view_file`, `write_to_file`, `run_command`) ended in `ERROR`, because the broken `googlecloudtools.datacloud_telemetry` `PreToolUse` hook aborts every tool before it runs. The agent's own diagnosis was that, on Windows, the hook command wraps the script path in an extra pair of literal quotes. So it is still unknown whether `accept-edits` writes files and whether shell commands fail, prompt or hang. **The test has to be re-run with that plugin disabled.**
- **`result.status` was `SUCCESS` again, for a turn that did nothing.** The response itself said every tool was blocked. Under §7 the runner would report this as `failed`: empty diff, every tool step in `ERROR`. This is the clearest example so far of why the CLI's status is never the outcome.
- **The agent reached outside the workspace.** Its first action was `view_file` on `C:\Users\ricky\.gemini\config\plugins\data-agent-kit-plugin\skills\dak-setup\SKILL.md`. That is a *second* user plugin, whose skills are injected into every session, and the agent went to read its files outside `H:\agy-smoke`. The hook blocked the read, so it is unknown whether `--sandbox` would have allowed it. **Rule:** every tool call's path parameters (`AbsolutePath`, `TargetFile`, …) are checked against the workspace while the run is in progress. One access outside the workspace fails the run and is shown in the event log, whether or not the CLI allowed it.
- **After the failures, the agent spawned a subagent** (`invoke_subagent`, `Model: "inherit"`) to try again. Subagents multiply cost and act out of view. **Rule:** `invoke_subagent` and `define_subagent` are not on the implementer allowlist, and using them fails the run unless you turn them on in that project's policy.
- **Output encoding.** The file came back as UTF-16LE with a BOM. That is PowerShell 5.1's `*>` redirect, not `agy`: the runner reads the child's stdout pipe directly as UTF-8. Test fixtures copied from these files are converted to UTF-8 first.

#### Plugin and agent commands (Windows, `agy` 1.3.3, October 12, 2026)

- **`agy plugin list` printed "No imported plugins."**, yet both smoke tests loaded hooks and skills from `%USERPROFILE%\.gemini\config\plugins\` (`googlecloudtools.datacloud_telemetry`, `data-agent-kit-plugin`). So `agy` also loads **legacy Gemini CLI plugins straight from `~/.gemini`**, outside its own registry (`agy plugin import [gemini|claude]` exists for migrating them). Consequences:
  - The probe cannot rely on `agy plugin list`. It also lists the **directory names** under `~/.gemini/config/plugins` and flags any that contain hooks. It reads plugin names and hook manifests only, never anything else in `~/.gemini`, which also holds sign-in files.
  - `agy plugin disable <name>` applies only to imported plugins, so it cannot switch off a legacy one. Moving the folder out of `config/plugins` can, and that decision is yours (the dashboard never does it).
- **`agy agents` listed nothing**, and `agy agent` has no flags other than `--help`. There is no built-in, restricted-tool agent to use, and nothing in the help shows how to define one. So for now the tool allowlist (§3.2) is enforced **only by watching the tool calls during the run** and failing on a violation. That limitation is stated in the run form when Antigravity is the implementer.
- Still to try later: whether an environment variable can point `agy` at an isolated config home (the equivalent of Codex's `--ignore-user-config`). Until one is verified, the plugin and hook acknowledgement in the run form stays.

#### Smoke test 3 results (Windows, `agy` 1.3.3, October 12, 2026): conclusive

The same command as smoke test 2, with `googlecloudtools.datacloud_telemetry` moved out of `~/.gemini/config/plugins`. It took 50 seconds and about 35,000 tokens plus 51,000 cached.

- **`--mode accept-edits` writes files without prompting.** `write_to_file` → `H:\agy-smoke\hello.txt` reached `DONE`.
- **Shell commands are auto-denied in headless mode, and the run does not hang.** stderr said: *"a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)). Alternatively, re-run with --dangerously-skip-permissions…"*. The final `result` carries `denied_actions: [{action: "command", display_name: "RunCommand"}]`.
- **The step state misleads.** The denied `run_command` step was reported as `DONE`, and `result.status` was `SUCCESS` with an empty response. The runner therefore takes denials **only from `result.denied_actions`** (and stderr), never from step state, and records each one as a run event.
- **Reading outside the workspace is allowed, even with `--sandbox`.** `view_file` on `%USERPROFILE%\.gemini\config\plugins\data-agent-kit-plugin\skills\dak-setup\SKILL.md` reached `DONE` (140 lines). `--sandbox` restricts the terminal, not file reads. The runtime path check in §3.2 is therefore the only containment for reads, and it is required, not optional.

**What this settles for the Antigravity implementer:**

1. **No shell for the implementer, by design.** It edits files and the runner runs every check itself (§7). Shell denials are expected. They are shown in the event log ("Antigravity asked to run `git status`; denied, because checks are run by Command Center"), and they do not fail the run on their own. The check results the runner feeds back in correction rounds replace the need for the agent to run tests itself.
2. **`permissions.allow` rules are possible but not used yet.** An allow-rule (`command(<target>)`) is the narrow equivalent of Claude Code's per-run `--settings` grant. It would be adopted only once the location of `settings.json` is known **and** it can be written outside the worktree. A settings file inside the workspace could be edited by the agent to widen its own permissions (§6). Until then, no command grants.
3. **`--dangerously-skip-permissions` stays refused**, even though `agy` itself suggests it.
4. **Reads outside the workspace fail the run.** Skills from legacy plugins make the agent read their files under `~/.gemini`, so with `data-agent-kit-plugin` installed, **every Antigravity run would fail** this check. The run form says so in advance, from the probe's plugin list, instead of letting the run fail after spending tokens. Your options are to move that plugin out as well, or to allow-list reads of that one plugin directory per machine, shown as a visible exception. The dashboard never quietly widens the check.
5. **Cost.** Each run has a floor of roughly 25,000–35,000 input tokens before any project context, and turns take 5–10 seconds. Stage timeouts and the cost readout are set with that in mind.

#### Where Antigravity keeps its extensions (Windows, October 12, 2026)

A search of `%USERPROFILE%\.gemini` after both broken and skill-reading plugins were moved to `.gemini\plugins-disabled` shows that Antigravity's state is spread over several folders:

| Folder | Holds |
| --- | --- |
| `.gemini\config\plugins\` | Legacy plugins that still load: `android-cli-plugin`, `chrome-devtools-plugin`, `gemini-api`, `google-antigravity-sdk`, `modern-web-guidance-plugin` |
| `.gemini\antigravity-cli\mcp\` | **MCP servers for the CLI**, for example `data-agent-kit-plugin_dak-notebook` and `…_dak-viz` |
| `.gemini\antigravity-cli\plugin_data\` | Plugin state |
| `.gemini\antigravity\…`, `.gemini\antigravity-ide\…` | Separate copies for the IDE and the shared app |

Consequences:

- **Moving a plugin does not remove the MCP servers it registered.** `data-agent-kit`'s MCP servers are still configured under `antigravity-cli\mcp` and reachable through the `call_mcp_tool` tool. The probe therefore lists **both** plugin folder names (`config\plugins`) **and** MCP server names (`antigravity-cli\mcp`). It reads directory names and server names only, nothing else under `.gemini`.
- **`call_mcp_tool` is not on the implementer allowlist by default.** An MCP server can reach networks, files and accounts outside the workspace, and the dashboard cannot see what a given server does. You can allow it per project, with each server named in the run form.
- **Any remaining plugin may inject skills** that make the agent read files outside the workspace, as `data-agent-kit-plugin` did. The out-of-workspace read check (§3.2) catches that. A clean smoke run with the remaining plugins confirms whether any of them do.
- The CLI's own config home appears to be `.gemini\antigravity-cli`. That is a lead for finding an isolated-config option later (§3.2), still unverified.

#### Smoke test 4 results (Windows, `agy` 1.3.3, October 12, 2026): one denied command ends the turn

Command: `agy -p "Create a file named hello2.txt containing hi." --output-format stream-json --mode accept-edits --sandbox --print-timeout 180s`, run in a fresh scratch repository, with both problem plugins moved out.

- **No reads outside the workspace this time.** The remaining five plugins did not cause any, so moving `data-agent-kit-plugin` out was enough.
- **The agent's first action was a shell command** (`run_command` → `Get-ChildItem`, just to look around). It was denied, this time with `state: ERROR` and the message *"user denied permission to run command … Do not attempt to circumvent this denial … Proceed without performing this action."* In smoke test 3 the same kind of denial was reported as `DONE`, so step state is inconsistent and stays untrusted.
- **The turn then ended without doing the task.** There was no `write_to_file`, the response was empty, `result.status` was `SUCCESS`, `denied_actions` held one command, and it took 38 seconds. In smoke test 3 the write happened only because it came *before* the command.

**This changes the "implementer gets no shell" plan from smoke test 3.** Agents routinely list a directory or run `git status` before editing. If the first denial ends the turn, most real Antigravity runs would stop before doing anything. Each one would be reported as `failed` (empty diff), but they would waste a run every time. The plan, in order of preference:

1. **Tell the agent up front.** The implementer prompt says that shell commands are unavailable, to use `list_dir`, `view_file`, `grep_search` and `find_by_name` to inspect the project, and that Command Center runs every build and test itself. This costs nothing but does not guarantee anything.
2. **Continue a turn that a denial ended, a bounded number of times.** If a turn ends with `denied_actions` and no file changes, the runner continues the same conversation (`--conversation <id>`) with *"Shell commands are not available in this run. Continue the task with the file tools."* It does this at most **twice** per stage, and every continuation appears in the event log. It never tries again with wider permissions.
3. **Narrow read-only command grants, only if they can be safe.** `permissions.allow` rules (for example `command(Get-ChildItem)`, `command(git status)`, `command(git diff)`) would avoid the problem entirely, but only once the location of `settings.json` is verified **and** the grant can be scoped to one run. A grant written into your global `agy` settings would apply to every other `agy` session on the machine, and to concurrent runs, while it existed. That conflicts with the "temporary, per-run grant" rule (§6). This stays unverified until then.
   - **Checked (October 12, 2026):** the only `settings.json` under `%USERPROFILE%\.gemini` is `antigravity-cli\settings.json`. That is a single, user-wide file, and no project-level or per-run settings file was found. So a grant cannot be scoped to one run today, and **option 3 is off**. The runner never writes to that file. It can be revisited only if a way to point `agy` at a separate config home for one run is verified. The dashboard never opens that file either, because it may sit next to sign-in data.
   - The same check confirmed that the mistaken run, where `cd` failed and `agy` started in `C:\WINDOWS\System32`, wrote nothing there (`Test-Path` → `False`). This is why the runner always checks the working directory and spawns in it directly, never through a chained shell line (§5).

The fake agent fixture gets a "denies first, then ends the turn" mode, so (2) is covered by tests.

#### Smoke test 5 results (Windows, `agy` 1.3.3, October 12, 2026): the upfront instruction works

Command: the same as smoke test 4, with the prompt starting *"Shell commands are not available in this session. Use only file tools such as list_dir, view_file and write_to_file."*

- **It went straight to `write_to_file`** for `hello3.txt` (`DONE`), then gave a one-line response. There was no `run_command`, no `denied_actions` and no read outside the workspace.
- It took 49 seconds and about 5,300 new tokens plus 34,000 cached, far cheaper than the earlier tests.
- **The path came back as `H:/agy-smoke/hello3.txt`, with forward slashes**, where earlier tests used `H:\agy-smoke\…`. The runtime path check normalises separators (and case, §5A) before comparing, and the test suite covers both forms.

**Conclusion:** plan item 1 (the upfront instruction) is the primary mechanism, and item 2 (continuing a turn a denial ended, at most twice) stays as the fallback. **Antigravity CLI verification is complete for AW.3.** What remains belongs to the adapter's own tests, not to the open questions.

## 4. Data model (SQLite, desktop only)

Projects reuse the existing `projects` table and its `local_path`. "Register a
local project folder" means creating or editing a project with a local path, so
there is no parallel registry. The new tables are:

```
agent_project_policy   project_id PK → projects
                       check_commands JSON   [{name, argv[], timeoutSec}]
                       excluded_paths JSON   (globs the agents may not read or write)
                       test_restrictions JSON (e.g. "no network", "unit only")
                       roadmap_source TEXT   (path + parser kind, or null)
                       defaults JSON         (planner/implementer/reviewer + model + effort)

agent_run              id, project_id, status, stage, request JSON (task + roles),
                       workspace_kind (git_worktree | snapshot_copy),
                       workspace_path, base_ref, branch,
                       correction_round 0..3, outcome JSON,
                       runner_epoch, created_at, updated_at, ended_at

agent_run_event        run_id, seq INTEGER  (PK run_id+seq, gapless per run)
                       ts (DB time), stage, agent (planner|implementer|reviewer|
                       checks|advisor|system), kind, payload JSON (bounded, redacted)

agent_run_intent       id, run_id, kind (start|stop|approve|deny|resume),
                       payload JSON, created_at, claimed_at   (API → runner queue)

agent_workspace_lock   lock_key PK (realpath of the working copy), run_id
```

- **Statuses:** `queued → preparing → planning → implementing → checking →
  reviewing → (correcting → checking → reviewing)×≤3 → awaiting_approval →
  succeeded | failed | stopped | interrupted`.
- **`agent_workspace_lock`** has a primary key on the working-copy realpath. The
  insert happens in the same transaction that moves a run to `preparing`, so two
  runs cannot hold the same working copy. A second run on the same project gets
  its own worktree. A run that must touch the original folder (non-Git apply-back)
  takes the lock on the original.
- **`runner_epoch`** is a random value the runner generates at startup. Any run
  that is still "active" with a stale epoch was orphaned by a crash or restart.
  See §7.

## 5. Workspace strategy

| Project kind | Strategy |
| --- | --- |
| Git repository | `git worktree add <runstore>/wt/<runId> -b agent/<runId> <base>` from the current `HEAD`. Your checkout, index and uncommitted work are never touched. The result is a branch you can inspect, merge or delete. |
| Git with uncommitted changes | The run starts from `HEAD`, **not** from your uncommitted edits, and the UI says so before you start. Snapshotting dirty state into the worktree is a later option. |
| Not a Git repository | Copy into `<runstore>/snap/<runId>/base` (honouring exclusions and skipping `node_modules` and the like), then `git init` + commit there and work in a worktree of *that*. You get the same diff and review experience. Copying back to the original folder is a separate, approval-gated action that first makes a timestamped backup. |

#### Where things live: workspace roots and two kinds of run storage

**All project work happens on a drive you choose.** On the Windows PC that is
the `H:` drive: projects are in `H:\Ai Repo clones`, and worktrees go in
`H:\Ai Repo worktrees`. The design therefore splits storage in two and makes
both locations per-machine settings rather than fixed paths:

| Setting | Holds | Windows PC | Default |
| --- | --- | --- | --- |
| **Workspace roots** (one or more) | The projects you can register | `H:\Ai Repo clones` | None. You add them in settings. |
| **Worktree root** (`<worktrees>`) | One worktree or snapshot per run | `H:\Ai Repo worktrees\command-center` | `<userData>/agent-runs/wt` |
| **Run control storage** (`<runstore>`) | The database, event logs, per-run permission-grant files, and schema files | Stays in `%APPDATA%\Command Center` on `C:` | `<userData>/agent-runs` |

Rules that follow from this:

- **A project must be inside a workspace root.** Registering a folder outside every root is refused, so a mistyped or malicious path cannot point an agent at `C:\Windows` or your home folder. Containment is checked with the normalised realpath (§5A), so a junction under `H:\Ai Repo clones` that leads elsewhere is rejected too.
- **Permission grants never sit next to the code.** The per-run settings, schema and grant files live in `<runstore>` on `C:`, outside every workspace and worktree. An agent working in a worktree therefore cannot edit its own permissions.
- **Command Center uses its own subfolder** (`…\Ai Repo worktrees\command-center\<shortId>`). `H:\Ai Repo worktrees` already holds worktrees made by other tools. The runner never lists, changes or cleans up anything it did not create. Its cleanup acts only on worktree paths recorded in its own database.
- **Spaces in paths** (`Ai Repo clones`) are normal. Every spawn uses argv arrays with `shell: false`, and the test fixtures deliberately use paths that contain spaces.
- **The drive has to be there.** If `H:` is missing (unplugged, renamed or not yet mounted), the probe shows "workspace root unavailable", new runs are refused, and recovery marks affected runs `interrupted`, saying why. Nothing falls back to `C:`.
- **The same drive for repository and worktree is the fast path.** A Git worktree can live on another drive, but keeping clones and worktrees both on `H:` avoids cross-drive copying for non-Git snapshots.
- **The filesystem should be NTFS.** On exFAT or FAT32, Git worktrees still work, but there are no file permissions or junctions, and case handling differs. The probe reports the filesystem type of each root and warns on anything other than NTFS (or APFS on the Mac).
- **On the Mac**, the same settings point wherever your projects live there. The paths are per machine; the layout is the same.

Cleanup removes worktrees only for runs you have dismissed, and never removes a
branch that has unmerged commits without asking.

## 5A. macOS and Windows

The control center has to work the same way on your Mac and your Windows
machine. The repository already ships desktop builds for both, and CI already
runs a `Unit tests (Windows)` job, so this is a requirement from AW.1 onward,
not a later port. Several parts of the design behave differently on Windows:

| Concern | macOS | Windows | Rule |
| --- | --- | --- | --- |
| **Finding the CLI** | `claude` and `codex` on `PATH`, Homebrew paths | npm installs **`.cmd` shims**. Node refuses to spawn them with `shell: false`, and running them through a shell would bring back command-line injection. | Reuse the approach in `desktop/launch.js` and `desktop/ollama.js`: resolve to a real executable (a native `.exe`, or `node.exe` + the package's JS entry point found from the shim). **Never `shell: true`.** If the CLI cannot be resolved, the probe reports it as not installed, with the path it tried. |
| **Which `PATH`** | A Dock-launched app does not see your shell profile's `PATH` (Homebrew, nvm) | Git Bash, PowerShell and an app launched from the Start menu can each see a different `PATH`. On October 12, 2026, `codex` was "command not found" in Git Bash on the Windows PC. | The probe never relies on one shell's `PATH`. It searches the inherited `PATH` plus the known install locations (`%APPDATA%\npm`, `%LOCALAPPDATA%\Programs`, Homebrew, `~/.local/bin`, nvm/volta shims resolved to real files), reports **every path it tried**, and lets you set an explicit executable path per provider. |
| **Check commands** (`npm test`, …) | Spawned directly | `npm` is also `npm.cmd` | Resolved the same way (`node.exe` + `npm-cli.js`) when the policy is saved, and stored as the resolved argv, so a run never resolves anything from text in a browser request |
| **Stopping a run** | `detached: true` creates a process group; SIGTERM the group, then SIGKILL | No POSIX process groups or SIGTERM | Each platform gets its own stop routine: process groups on macOS; on Windows, `taskkill /PID <pid> /T` then `/T /F` after the grace period (a Job Object is a possible later upgrade). The cancellation test checks that **no grandchild process survives on either platform**. |
| **Path containment** | APFS is usually case-insensitive | NTFS is case-insensitive; drive letters; `\\?\` and UNC prefixes; junctions | Compare `realpath.native` results after normalising case on both. Reject UNC and device paths as project roots. Treat junctions the same as symlinks. |
| **Lock key** (`agent_workspace_lock`) | — | — | The normalised realpath, so `C:\Code\App` and `c:\code\app` are the same working copy |
| **Git worktrees** | Fine | Long paths, and files held open by an editor or antivirus block removal | Keep run storage paths short (`<runstore>/wt/<shortId>`), set `core.longpaths=true` for the worktree, and retry removal with back-off. A worktree that still cannot be removed is reported, not ignored. |
| **Diffs** | — | `core.autocrlf` can make every line appear changed | Compute diffs with `--ignore-cr-at-eol` for display and summaries, while the commit keeps what the agent wrote |
| **Run storage** | `~/Library/Application Support/Command Center/agent-runs` | `%APPDATA%\Command Center\agent-runs` | Both come from `app.getPath("userData")`, as the database does today |
| **Provider availability** | — | — | Probed **per machine**. A CLI that is installed and signed in on the Mac but not on Windows shows as unavailable there. Defaults are shared, but availability never is. |

The fake agent CLI is a Node script started through `process.execPath`, so the
whole test suite runs identically on the Linux and Windows CI jobs. macOS is
covered locally and by the macOS desktop build. Adding a macOS unit-test job to
CI is worth considering once the runner lands.

## 6. Security model

1. **Scope.** Each agent process runs with `cwd` set to the run's workspace.
   Claude Code gets `--add-dir` only for that workspace. The runner rejects any
   policy path that resolves (via `realpath`, after following symlinks) outside
   the workspace. Excluded paths go in as `--disallowedTools` path rules plus a
   post-run check that fails the run if an excluded path changed.
2. **No bypass flags, ever.** `--dangerously-skip-permissions` and its
   equivalents in the other CLIs are in a denylist that the adapter unit tests
   assert against the generated argv. Permissions are granted narrowly instead.
   For Claude Code, the runner writes a per-run `--settings` file into
   `<runstore>/runs/<runId>/` that allows Read, Edit and Write plus
   `Bash(<each configured check command>)`, and denies `git push`, `git merge`,
   network-publishing commands and deletion outside the workspace. That file is
   the "temporary permission grant" and is deleted when the run ends or is stopped.
3. **Separate approval for anything external or irreversible.** Merging, pushing,
   publishing, deploying, releasing, applying back to a non-Git folder, deleting
   files outside the run workspace, and any check flagged `touches_real_data`
   all become `awaiting_approval` intents. These reuse and extend
   `AGENT_ACTION_SPECS` in `approvals.ts`, so there is one vocabulary.
4. **No shell from the browser.** Check commands are `argv[]` arrays stored in
   the project policy, run with `shell: false`. The policy editor validates them
   with Zod. Run requests reference checks by name; they never contain commands.
5. **Credentials.** Agent environment variables are an allowlist (PATH, HOME,
   LANG, and each provider's documented variables). Event payloads go through a
   redactor (known token patterns, `Authorization:`, anything matching the env
   allowlist's secret names) before they are stored. Paths under credential
   directories are never read by the dashboard.
6. **HTTP.** This inherits `src/proxy.ts` unchanged: localhost-only, the desktop
   secret, and cross-site rejection on POST, PUT, PATCH and DELETE. SSE is a GET
   and is read-only.

## 7. Orchestration and truthful status

```
inspect   runner reads CLAUDE.md / AGENTS.md / README / policy  (no agent)
plan      planner → strict JSON {task, scope_paths, acceptance, checks[]}  (schema-validated)
implement implementer CLI in the worktree, stream-json → events
checks    runner runs the policy's check commands itself; records exit codes + bounded output
diff      runner computes `git diff base...HEAD` + untracked files itself
review    reviewer gets {plan, diff, check results} → strict JSON {verdict, findings[]}
correct   if findings are actionable and round < 3 → implementer gets findings → checks → review
final     outcome = f(diff non-empty, every required check passed, reviewer verdict = approve)
```

- **The agent's own claims never set the status.** `succeeded` requires all
  three facts the runner observed itself: a non-empty diff confined to allowed
  paths, every required check exiting 0, and a schema-valid reviewer approval.
  Anything else is `failed`, with the specific missing fact named.
- **Stop.** The runner `kill`s the process **group** (it spawns with
  `detached: true` and sends `SIGTERM`, then `SIGKILL` after a grace period).
  Commits are preserved: the implementer's work is committed to the run branch
  before the stop is acknowledged, as `wip: stopped by user`. The per-run grant
  is deleted, the lock is released, and the run becomes `stopped`.
- **Restart recovery.** At startup the runner finds active runs with a stale
  epoch, kills any surviving process group it recorded (by PGID), marks them
  `interrupted`, and appends a `system` event explaining why. It does **not**
  auto-restart them.
- **Resume.** This is an explicit user action. It starts a new stage attempt
  from the last *completed* stage boundary, re-using the worktree. For Claude
  Code it may use `--resume <session-id>` when one was recorded. It is never
  "pick up mid-command".

## 8. Live events and reconnection

- `GET /api/agent-runs/:id/events` is a Server-Sent Events stream. Each event's
  `id:` is its `seq`. On reconnect, the browser sends `Last-Event-ID`, and the
  server replays `seq > lastId` from SQLite, then tails. Because `seq` is
  gapless per run, assigned in the insert transaction, and the client discards
  `seq <= lastSeen`, there is **no loss and no duplication**, including across
  a dashboard restart.
- Payloads are bounded (for example, 16 KB per event, with long command output
  split into chunks), so a chatty build cannot bloat the database or the browser.

## 9. UI (existing components only)

- `/agents`: a project picker (projects that have a `local_path`), a task box or
  "Next eligible task" (from the project's own task board in AW.4, or a roadmap source; §10A idea 5), role
  and model and effort pickers populated from probes, and a run-history table.
- `/agents/runs/[id]`: a stage timeline, a live event log filterable by agent,
  a changed-files list with a unified diff, check results, review findings per
  round, the final verdict with its three facts, and Stop, Resume and
  approval buttons.
- `/settings/agents`: provider probes (installed, version, authenticated yes/no,
  models), **workspace roots and the worktree root** (with drive and filesystem
  status), defaults, and per-project policy.

## 10. What to bring over from `flight-deck-team`

That path lives on your Mac, so I could not read it. When it is available,
either copy it into the repo under `reference/` (gitignored) or paste the key
files. Then extract the **ideas** and drop the assumptions:

- **Keep:** the stage machine, the prompt templates for planning and review, how
  it parses each CLI's output, and its correction-loop rules.
- **Drop and replace with per-project policy:** hard-coded project paths, its
  roadmap file convention, its test commands, and any permission flags it
  passes. Anything Flight-Training-specific becomes a field in
  `agent_project_policy`, not a constant.

## 10A. Prior art: open-source projects (surveyed October 12, 2026)

A survey of open-source projects with 1,000 or more GitHub stars that orchestrate coding agents, plus libraries for the hard parts. Star counts and licences were read from each repository page on the survey date.

### Whole applications: borrow ideas, do not adopt

| Project | Stars | Licence | Stack | Relevant ideas | Why not adopt it |
| --- | ---: | --- | --- | --- | --- |
| [Parallel Code](https://github.com/johannesjo/parallel-code) | ~1.0k | MIT | Electron, SolidJS, TypeScript | **The closest match:** Claude Code, Codex, Gemini **and Antigravity** CLIs, a worktree per task, a diff viewer with inline review comments, and **symlinking `node_modules` and other gitignored folders into each worktree** so runs need no reinstall | macOS and Linux only. A different UI framework. Its own task model, with no planner, reviewer or correction loop. |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | ~28k | Apache-2.0 | Rust + Node | **Inline diff comments sent back to the agent as feedback**, which is exactly the UI for correction rounds. It also normalises logs across about 10 agent CLIs. | **Sunsetting** (per its README), and a Rust backend |
| [Crystal](https://github.com/stravu/crystal) | ~3.1k | MIT | Electron | An Electron app running Claude Code and Codex in parallel worktrees, the same shape as ours | Deprecated in February 2026 in favour of Nimbalyst |
| [Agent of Empires](https://github.com/agent-of-empires/agent-of-empires) | ~3.3k | MIT | Rust, tmux | `aoe agents` reports **availability per machine**, the same idea as our probe. It also has a web dashboard with diff review and an HTTP API. | tmux-based, so Windows works only through WSL2 |
| [Claude Squad](https://github.com/smtg-ai/claude-squad) | ~8.2k | **AGPL-3.0** | Go, tmux | A worktree and branch per agent session | AGPL, so ideas only and **no code copied**. tmux, no Windows. |

**Conclusion:** none of them replaces this design. Each would mean giving up this codebase's stack and its security rules: no shell, edit-only Antigravity, runner-owned checks, and outcomes the runner verifies itself. Several assume tmux, so they have no native Windows. Their best ideas are adopted below, each placed in a specific release and adapted to those rules.

### Ideas adopted, by release

| # | Idea | From | Release | How it is adapted here |
| ---: | --- | --- | --- | --- |
| 1 | **One commit per stage, navigable in the diff view** | Parallel Code (per-commit navigation) | **AW.1** (commits); **AW.2** (round navigation) | The runner commits after each stage it controls (`implement`, `correction 1…3`, `stopped`), so the run branch *is* the history. The run-detail page shows the whole diff, or one round's diff, with no extra storage. The commit messages are written by the runner, never by the agent. |
| 2 | **Changed-files overview, ordered for review** | Parallel Code ("guided change tour") | **AW.1** | The file list is grouped by directory and ordered by lines changed, with new, deleted and renamed files marked, and **files in excluded paths or outside the plan's `scope_paths` flagged first**. It is computed from the diff, not narrated by an agent. An agent-written "tour" or confidence score is not used, because it is an agent's claim (§7). |
| 3 | **Worktree recovery report at startup** | Vibe Kanban (orphan and expired workspace cleanup) | **AW.1** (report); **AW.4** (retention) | At startup the runner compares the worktrees recorded in its database with the folders in its own `command-center` subfolder, and **reports** any mismatch (recorded but missing, or present but unknown) as a system event. It removes nothing. AW.4 adds a retention setting (for example, "remove worktrees of dismissed runs after 14 days"), which never touches branches with unmerged commits. |
| 4 | **Inline diff comments sent to the agent** | Vibe Kanban | **AW.2** | You can comment on lines of the diff. Those comments join the reviewer's findings for the next correction round, labelled as yours, never merged into the reviewer's verdict. A comment also counts as "actionable", so it can start a round on its own, but it still counts toward the three-round limit. |
| 5 | **Next eligible task from the dashboard's own task board** | Vibe Kanban (task board feeding agents) | **AW.4** | **This is better than parsing roadmap files.** The dashboard already has per-project tasks, milestones and **dependencies with blocked status**. "Next eligible task" becomes: the highest-priority open task in that project that is not blocked and not already linked to an active run. A run links back to its task and posts its outcome to the task's activity, and the task is never marked done automatically. A roadmap *file* stays an optional second source (`roadmap_source`) for projects managed outside the dashboard. |
| 6 | **Dependency folders linked into worktrees** | Parallel Code | **AW.4** | Opt-in per project, as a list in the policy (`node_modules`, `.venv`, …). On Windows it uses a junction, since symlinks need Developer Mode. The policy editor warns that a check writing into a linked folder changes the original project's copy. It stays off until the policy editor exists, so AW.1 runs a project's own install step when its checks need one. |
| 7 | **A draft pull request created from the run, after approval** | Vibe Kanban (PRs with generated descriptions) | **AW.4** | Pushing the run branch and opening a **draft** PR are each approval-gated actions (§6.3). The description is built by the runner from facts it recorded: the task, the files changed, the check results and the reviewer verdict. Anything an agent wrote is quoted as such. It uses the dashboard's existing GitHub connection, and nothing is ever merged. |
| 8 | **Availability shown per machine** | Agent of Empires (`aoe agents`) | **AW.1** | This confirms the probe design in §3 and §5A: each machine reports its own installed and signed-in providers. Nothing new to build. |
| 9 | **Watch runs from your phone** | Parallel Code, Agent of Empires (phone access over Wi-Fi or Tailscale) | **AW.5** | Once the control center runs on the mini PC, the run list and run-detail pages work on a phone screen over Tailscale. Watching works with the operator login. **Approvals from the phone need that login again**, because they change things outside the run. |
| 10 | **A container sandbox per project** | Parallel Code, Agent of Empires (Docker, Podman, Apple Containers) | **Later (AW.6 candidate)** | This would turn §13's "not an OS-level sandbox" into a real boundary. It is deferred because it needs Docker Desktop on Windows, and because **Parallel Code reports that Antigravity cannot sign in inside Docker**, so it would apply to Claude Code and Codex first. |

Not adopted: per-workspace dev servers and browser previews (Vibe Kanban). They open network ports and run long-lived processes outside the run's control, which is outside this product's boundaries for now.

### Libraries

| Library | Stars | Licence | Use | Decision |
| --- | ---: | --- | --- | --- |
| [diff2html](https://github.com/rtfpessoa/diff2html) | ~3.4k | MIT | Renders unified git diffs as HTML: line-by-line or side-by-side, syntax highlighting | **Adopt in AW.1** for the run-detail diff view. It is framework-agnostic and takes a diff string, so a small client component wraps it. That is one new runtime dependency, which fits the "small number of replaceable dependencies" rule in `ARCHITECTURE.md`. |
| [execa](https://github.com/sindresorhus/execa) | ~7.6k | MIT | Process spawning, line streaming, termination | **Not adopted for now.** On Windows it resolves `.cmd` shims through `cross-spawn`, which runs them via `cmd.exe`. That is a shell, which §5A rules out. The existing `ndjson.ts` and `node:child_process` cover the rest. To be reconsidered only if its Windows path can be confirmed shell-free. |
| [simple-git](https://github.com/steveukx/git-js) | ~3.9k | MIT | Git wrapper | **Not adopted.** It has no worktree commands, and plain `git` calls with argv arrays are just as simple. |
| [tree-kill](https://github.com/pkrumins/node-tree-kill) | ~360 | MIT | Kill process trees | **Not adopted:** below the 1,000-star bar, last released in 2019, and it once had a command-injection bug. Its method (`taskkill /T /F` on Windows, `pgrep -P` on macOS) is about 30 lines in `process.ts`, written with argv arrays. |

Any code borrowed from an MIT or Apache-2.0 project keeps that project's licence notice in a `THIRD_PARTY_NOTICES.md`. Nothing is copied from AGPL projects.

## 11. Release plan

Each release is a separate PR and is independently testable.

| Release | Contents | Done when |
| --- | --- | --- |
| **AW.1 — Vertical slice** | Schema, runner process, Git worktree workspaces, Claude Code as implementer, runner-owned checks and diff, **single-pass review by Claude** (separate session), SSE with replay, Stop, restart → `interrupted`, `/agents` and run-detail pages, and a scripted **fake agent CLI** for tests and the demo. From §10A: a commit per stage (1), a changed-files overview ordered for review (2), a worktree recovery report (3), and the `diff2html` diff view | select project → choose implementer → submit → watch → inspect diff and verdict, demonstrated on a synthetic temp project |
| AW.2 — Codex roles + corrections | Codex adapter (after the help/flag probe on your Mac) as planner and reviewer, structured planner and reviewer JSON, up to 3 correction rounds, **per-round diff navigation (1) and inline diff comments as correction input (4)** | Correction loop proven with the fake agent emitting findings |
| AW.3 — Antigravity + LM Studio | Antigravity implementer adapter (headless mode confirmed, §3.2), after the smoke tests in §3.2 pass. LM Studio advisory summaries. | Probe-driven availability, never a silent fallback |
| AW.4 — Policy, resume, non-Git, approvals | Per-project policy editor, exclusions and test restrictions, non-Git snapshot strategy, explicit Resume, approval-gated merge, push and apply-back. From §10A: **next eligible task from the dashboard's own task board (5)**, opt-in dependency-folder links (6), an approval-gated draft PR (7), and worktree retention (3) | Approval gates covered by tests |

Starting AW.1 with only Claude Code is deliberate: it is the one CLI verified
here, and the fake agent proves the orchestration without needing any real
credentials in CI.

## 12. Test plan (from AW.1 onward, `tests/unit/agent-*.test.ts`)

All tests use the **fake agent CLI**, a small Node script that reads its
instructions from env or argv and emits stream-json, edits files, sleeps or
crashes on demand. Each test also uses a temp `git init` project under
`os.tmpdir()`. No real providers are called and no real data is touched.

| Area | Test |
| --- | --- |
| Project isolation | Registering a folder outside every workspace root is refused. A policy path that escapes the workspace (via `..`, a symlink or a junction) is rejected. Grant and schema files are never inside the worktree. Cleanup never touches a worktree it did not create. A missing root refuses new runs without falling back to another drive. Paths contain spaces. A changed excluded path fails the run. The worktree path is under run storage, never the original project. |
| Input validation | Zod rejects shell strings, unknown roles, unverified models, unknown check names and oversized tasks. The generated argv never contains a bypass flag. |
| Concurrency | Two concurrent starts on the same working copy produce one lock and one refusal. Two runs on the same project get separate worktrees. |
| Event reconnection | Reconnecting with `Last-Event-ID` = k yields exactly `seq > k`, including after a simulated server restart. |
| Cancellation | Stop kills a fake agent that spawned a grandchild, and no descendant survives (checked on the Linux and **Windows** CI jobs). The work is committed as `wip` and the status is `stopped`. |
| Cross-platform paths | Case and drive-letter variants of one folder map to one lock key. UNC and device roots are rejected. A junction or symlink out of the workspace is rejected. A `.cmd` shim is never spawned. |
| Cleanup | The per-run settings file is gone and the lock is released after success, failure, stop and crash recovery. |
| Truthful status | A fake agent that *says* "all tests pass" while the check exits 1 produces `failed`. An empty diff produces `failed`. A malformed reviewer JSON produces `failed`, not approved. |
| Recovery | A run left active with a stale epoch becomes `interrupted` with an explanatory event, and is not auto-restarted. |

The demo is a script (`npm run agents:demo`) that creates a disposable project
in a temp directory, registers it in a **temp database** (`DATABASE_PATH` points
at the temp directory), runs the fake agent end to end, prints the event log
and diff, and deletes everything.

## 13. Risks and limitations to state up front

- ~~**Antigravity may not be scriptable.**~~ **Resolved:** `agy -p` is a headless
  mode (§3.2). What remains is how it behaves when a turn needs a shell
  command, and how it reports sign-in status.
- **The runner is only alive while the app is open**, the same as automations.
  Closing the app interrupts runs, and they show as `interrupted`, honestly.
- **Agent CLIs change their flags often.** Each adapter pins the flags it uses,
  and the probe fails loudly when they disappear.
- **Cost and quota.** Three roles × up to four passes can be expensive. The run
  form should show which models will be used before you start. Adding a token or
  cost readout is a later item.
- **Scope of the permission model.** The CLIs' own sandboxes enforce the actual
  file and command limits. The dashboard configures them narrowly and verifies
  results afterwards, but it is not itself an OS-level sandbox.

## 14. Kickoff checklist (before the first AW.1 commit)

1. ~~**Product decision (§2.1)**~~ **Done** (October 12, 2026): confirmed as the product, desktop-first. `NEXT.md` updated.
2. ~~**Architecture decision (§2.3)**~~ **Done**: the separate runner process was approved with the plan.
3. **On the development Mac**, capture and paste into this note:
   - `claude --version` and `claude --help`, to confirm the flags in §3 match the installed version
   - **Codex: all done** (§3.1). Help output and version (0.160.0 on the Mac, 0.162.1 on Windows), `codex login status` (Windows), and the effort key verified on the Mac on October 12, 2026. Availability is still probed per machine at run time (§5A).
   - ~~The Antigravity CLI's `--help`~~ **Done** (`agy` 1.3.3 on Windows, §3.2). Still needed: `agy models` and the smoke tests in §3.2
   - `lms ls` (LM Studio), if the advisor is wanted
4. **Make `flight-deck-team` available** (§10) and record which ideas carry over.
5. **Create the branch** from the latest `main`. Run `npm run db:generate` once
   before changing the schema to confirm the migration metadata is clean.

## 15. AW.1 build list

The order matters: each step is testable before the next one starts.

| # | Files | What |
| ---: | --- | --- |
| 1 | `src/core/agents/types.ts`, `schema.ts` | Run statuses and stages, event kinds, the Zod schemas for run requests (task, roles, model, effort, check names) and for planner and reviewer output |
| 2 | `src/db/schema.ts` + generated `drizzle/00xx_agent_runs.sql` | `agent_project_policy`, `agent_run`, `agent_run_event`, `agent_run_intent`, `agent_workspace_lock` (§4). SQLite only, and asserts desktop mode. |
| 3 | `src/core/agents/availability.ts` | `isAgentRunsEnabled()`: true only in desktop local mode. Used by routes, navigation and the runner. |
| 4 | `src/core/agents/events.ts` | Append (gapless `seq` inside a transaction), a bounded and redacted payload, and `readSince(runId, seq)` |
| 5 | `src/core/agents/redact.ts` | Token, header and env-secret redaction. Pure, so it can be tested exhaustively. |
| 6 | `src/core/agents/workspace.ts`, `src/core/agents/roots.ts` | Workspace roots, the worktree root and run-control storage as per-machine settings (§5). Worktree create and remove inside Command Center's own subfolder only, realpath containment checks against the roots, a drive-missing check, lock acquire and release, **a runner-authored commit after each stage**, and the `git diff base...HEAD` summary with a **changed-files overview ordered for review** (§10A ideas 1–2). |
| 7 | `src/core/agents/process.ts`, `src/core/agents/resolve-executable.ts` | Spawn with `shell: false` from a resolved executable (no `.cmd` shims, §5A), and record the PID and process group. Stop: on macOS, SIGTERM then SIGKILL to the group; on Windows, `taskkill /T` then `/T /F`. Output goes through the existing `ndjson.ts` parser. |
| 8 | `src/core/agents/adapters/claude-code.ts`, `adapters/fake.ts` | `probe()`, `buildArgv()` (asserted to never include a bypass flag), the per-run `--settings` grant file, and stream-json → events |
| 9 | `src/core/agents/orchestrator.ts` | The stage machine in §7. The final status is computed only from facts the runner observed. |
| 10 | `runner/index.ts` (+ `npm run runner`) | Claims intents, runs the orchestrator, epoch-based recovery at startup, and the **worktree recovery report** (§10A idea 3: report mismatches, remove nothing) |
| 11 | `desktop/main.js` | Forks the runner next to the server, passes the run-storage path, and stops it on quit |
| 12 | `src/app/api/agent-runs/**` | `POST` creates a start intent, `POST /:id/stop` creates a stop intent, `GET /:id` returns the run, and `GET /:id/events` streams SSE with `Last-Event-ID` replay. All of them return 404 when the feature is disabled. |
| 13 | `src/app/agents/**`, `src/app/settings/agents/**`, `src/components/agents/**`, `src/config/navigation.ts` | Run form, history, run detail (timeline, events, diff via `diff2html` (§10A), checks, verdict, Stop), and **settings: provider probes, workspace roots and the worktree root** (so `H:\Ai Repo clones` and `H:\Ai Repo worktrees` can be set from AW.1) |
| 14 | `tests/unit/agent-*.test.ts`, `tests/fixtures/fake-agent.mjs` | The test plan in §12 |
| 15 | `scripts/agents-demo.ts` (+ `npm run agents:demo`) | Disposable synthetic project + temp database, end to end with the fake agent |
| 16 | `README.md`, this note | Setup, usage, validation results, and the limitations that remain |

AW.1 is done when `typecheck`, `lint` and `test:unit` pass, the demo runs
cleanly, and every slice has passed independent review and merged. How the
steps are sliced into rounds and PRs: [`AW1-slices.md`](AW1-slices.md).
(Owner decision, October 28, 2026: Claude merges each PR once its independent
review is answered and CI is green on the exact head; see `AGENTS.md`.)

## 16. Build plan for AW.2–AW.6

The same format as §15: steps in order, each testable before the next. Every release ships as one or more PRs (batches of rounds), each opened from the latest `main`; a release starts once the previous one has merged. Claude merges each PR after its independent review is answered and CI is green on the exact head (owner, October 28, 2026). Each release is done only when `typecheck`, `lint` and `test:unit` pass on the Linux **and Windows** CI jobs, its manual acceptance check passes on the named machine, and the PR is open for independent review.

### 16.1 Delivery sequence and gates

| Release | Starts when | Manual acceptance (machine) | Open items it needs first |
| --- | --- | --- | --- |
| AW.1 | #40 merged | Fake-agent demo, then one real Claude Code run on a scratch project in `H:\Ai Repo clones` (Windows PC) and one on the Mac | None |
| AW.2 | AW.1 merged | A real run with Claude Code implementing, Codex planning and reviewing, and at least one correction round (Windows PC and Mac) | None. The effort key was verified on October 12, 2026 (§3.1). |
| AW.3 | AW.2 merged | A real run with Antigravity implementing and Codex reviewing, on the Windows PC | None. Antigravity verification is complete (§3.2). |
| AW.4 | AW.3 merged | Next-task pick from a real project's task board; an approved draft PR; an apply-back on a non-Git scratch folder (Windows PC) | None |
| AW.5 | The mini PC is running, and AW.4 merged | Watching and approving a run from a phone over Tailscale | Mini PC OS, Tailscale set up |
| AW.6 | You decide to build it | A Claude Code run inside a container | Docker Desktop or Podman installed |

### 16.2 AW.2 — Codex planner and reviewer, and correction rounds

| # | Files | What |
| ---: | --- | --- |
| 1 | `src/core/agents/schemas/plan.ts`, `schemas/review.ts` | Zod schemas, which are the single source of truth, exported to JSON Schema files (Zod 4 `toJSONSchema`) for `--output-schema` and `--json-schema`. A plan is `{task, scope_paths[], acceptance[], checks[]}`. A review is `{verdict: approve\|request_changes, findings[{id, severity: blocking\|major\|minor\|nit, file?, line?, message, actionable}]}`. |
| 2 | `src/core/agents/adapters/codex.ts` | `probe()` (`codex --version`; `codex login status` → signed in yes/no, cached with a timestamp). On Windows the executable is resolved from `%APPDATA%\npm\codex.cmd` to its real entry point (§5A). `buildArgv()` for the planner and reviewer roles: `exec -`, `--json`, `--output-schema`, `-o`, `-m`, `-c model_reasoning_effort=<none\|minimal\|low\|medium\|high\|xhigh\|max>` (validated locally first), `-s read-only`, `-C <worktree>`, `--ignore-user-config`. Event mapping from the verified `--json` shape, with the nested error message decoded (§3.1). Denylist assertions (§3.1). |
| 3 | `src/core/agents/prompts/{planner,reviewer,correction}.md` | Prompt templates. Project instructions (`CLAUDE.md`, `AGENTS.md`), diffs, check output and your comments go in as **fenced data blocks**, never as instructions. Any instruction text found inside them is ignored. |
| 4 | `src/core/agents/orchestrator.ts` | Adds a `plan` stage before `implement`, and the loop `checks → review → correct`. **A round starts** when there is a blocking or major finding marked actionable, a required check failing, or a comment from you. **It ends** in `succeeded` (approve, required checks passing, non-empty diff confined to scope) or `failed`, naming the facts still missing after round 3. |
| 5 | `src/core/agents/types.ts`, run form | Role settings per run: planner, implementer and reviewer, each with provider, model and effort, defaulting to Codex GPT-6.1 Sol (medium) for planner and reviewer. If the reviewer uses the same provider as the implementer, the run is labelled **"same provider, separate session"**, so independence is never overstated. |
| 6 | `src/db/schema.ts` + migration | `agent_run_comment` (run, round, file, line, body, created_at) for your inline diff comments (§10A idea 4) |
| 7 | `src/components/agents/**` | A round switcher on the diff (§10A idea 1), inline comments on diff lines, and per-round findings with severity |
| 8 | `tests/unit/agent-orchestrator-rounds.test.ts`, `agent-codex-adapter.test.ts`, `tests/fixtures/fake-agent.mjs` | The fake agent emits plan and review JSON (valid, malformed and missing). Tests cover: malformed review → `failed`; a third failing round → `failed`, not a fourth; a user comment alone starts a round; schema export round-trip; denylist; Windows `.cmd` resolution against a fixture shim. |
| 9 | `README.md`, this note | Codex setup and sign-in, role configuration, and what "same provider, separate session" means |

### 16.3 AW.3 — Antigravity implementer and the LM Studio advisor

| # | Files | What |
| ---: | --- | --- |
| 1 | `src/core/agents/adapters/antigravity.ts` | `probe()`: `agy --version`; `agy models` with ANSI codes stripped before parsing; the sign-in check (a minimal `-p` turn) **only on demand**, cached with a timestamp (about 25,000 tokens a time, §3.2). `buildArgv()`: `-p`, `--input-format stream-json`, `--output-format stream-json`, `--model`, `--effort`, `--mode accept-edits`, `--sandbox`, `--disable-slash-commands`, `--print-timeout <stage limit>`. Denylist (§3.2). |
| 2 | `src/core/agents/adapters/antigravity-inventory.ts` | Lists plugin folder names in `~/.gemini/config/plugins`, flags the ones with hook manifests, and lists MCP server names in `~/.gemini/antigravity-cli/mcp`. It reads names and manifests only, never other files under `~/.gemini`. |
| 3 | `src/core/agents/tool-monitor.ts` | The **implementer allowlist**: `view_file`, `list_dir`, `grep_search`, `find_by_name`, `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `finish`. Every path parameter is normalised (separators, case, realpath) and checked against the worktree. A tool outside the list, or a path outside the worktree, **stops the process group at once** and fails the run, naming the tool and path. `result.denied_actions` is recorded as events. |
| 4 | `src/core/agents/prompts/implementer-antigravity.md`, orchestrator | The upfront "file tools only" instruction (smoke test 5). The continuation rule: if a turn ends with denials and no file changes, it continues via `--conversation <id>`, **at most twice per stage**, and then fails. |
| 5 | Run form | When the inventory is not empty, the run form lists the plugins, hooks and MCP servers and needs an explicit acknowledgement, which is stored in the run request |
| 6 | `src/core/agents/adapters/lmstudio.ts` | The advisor talks to LM Studio's OpenAI-compatible API on `127.0.0.1:1234`. The model ID comes from `/v1/models` exactly (Gemma 4 12B). After the final verdict it writes a summary of the run as an `advisor` event, labelled **advisory**. If it fails or is offline, the outcome is unchanged. It reuses the patterns of the existing local AI client. |
| 7 | `tests/fixtures/agy/*.jsonl`, `tests/unit/agent-antigravity.test.ts` | The real smoke-test outputs, converted to UTF-8, replayed through the adapter. Tests cover: `SUCCESS` with an `ERROR` step → `failed` (smoke 1); a hook-blocked turn → `failed` (smoke 2); an outside-workspace read → stopped and `failed` (smoke 3); a denial-ended turn → two continuations, then `failed` (smoke 4); a forward-slash path inside the workspace → allowed (smoke 5); a subagent call → `failed`; inventory parsing; the advisor being offline does not change the outcome. |
| 8 | `README.md`, this note | Antigravity setup, the plugin acknowledgement, the advisor, and the cost per run |

### 16.4 AW.4 — Policy, tasks, non-Git projects, resume and approvals

| # | Files | What |
| ---: | --- | --- |
| 1 | `src/app/settings/agents/projects/[id]/**`, `src/core/agents/policy.ts` | The project policy editor. **Check commands** are argv arrays, resolved and stored when saved (§5A), with a timeout each. **Excluded paths** are globs. **Test restrictions** pick which checks are required or optional for agent runs. They are never described as network or OS isolation, which needs AW.6. **Dependency links** (§10A idea 6) come with the shared-folder warning. |
| 2 | `tool-monitor.ts`, `adapters/claude-code.ts`, `workspace.ts` | Exclusions are enforced three ways: the tool-path monitor (Antigravity), Claude Code `--disallowedTools` path rules, and a post-stage diff check that fails the run if an excluded path changed |
| 3 | `src/core/agents/next-task.ts` | **Next eligible task** (§10A idea 5): the project's tasks with status `todo`, no unfinished "must complete before" dependency, and no link to an active run. They are ordered by priority (`urgent > high > medium > low`), then due date (earliest first, none last), then creation date. Subtasks are eligible, and their parents are not picked while they have open subtasks. A roadmap-file source is optional: the first unchecked `- [ ]` item under a configured heading. |
| 4 | `src/db/schema.ts` + migration, `src/core/activity/**` | `agent_run.task_id`. When a run ends, its outcome (status, files changed, checks, verdict) is posted to the task's activity. **The task's status is never changed automatically.** |
| 5 | `src/core/agents/snapshot.ts` | Non-Git projects: copy into run storage (honouring exclusions), `git init`, commit, then work in a worktree of that copy (§5). **Apply-back** is an approval: first a timestamped backup of the files to be overwritten, then only the changed files are copied, then their hashes are checked. |
| 6 | `src/core/agents/resume.ts`, adapters | A `resume` intent continues from the last completed stage, using the recorded session IDs (`claude --resume`, `codex exec resume`, `agy --conversation`). It is refused if the worktree changed outside the run, which is detected by comparing it with the last stage commit. |
| 7 | `src/core/agents/approvals.ts` (extends `src/core/ai/approvals.ts`), `src/db/schema.ts` | Approval-gated actions, each **previewed, approved, then executed by the runner and logged**: merging into a branch you choose (it refuses if your checkout is dirty, and takes the lock on it), pushing the run branch, **opening a draft PR** with a description built from recorded facts (§10A idea 7; existing GitHub connection; never merged), applying back, and deleting a worktree that has unmerged commits |
| 8 | `src/core/agents/retention.ts` | A worktree retention setting for dismissed runs (§10A idea 3). It never removes branches with unmerged commits. |
| 9 | Tests | Excluded-path change → `failed`. Next-task ordering, dependencies and active-run exclusion. Task status never changes. Snapshot apply-back with its backup and hash check. Resume refused after an outside change. Each approval kind refused without approval. Merge refused on a dirty checkout. The draft PR body contains only recorded facts. |
| 10 | `README.md`, this note | The policy reference, approvals, and working with non-Git projects |

### 16.5 AW.5 — Self-hosted on your mini PC

| # | Files | What |
| ---: | --- | --- |
| 1 | `src/lib/auth-mode.ts`, `src/proxy.ts` | `AGENT_HOST_MODE=self-hosted`. It **refuses to start** with `AUTH_MODE=accounts`, `DATABASE_URL`, `DASHBOARD_PASSWORD` or any Railway environment variable present. |
| 2 | `src/core/auth/operator.ts` | Single-operator sign-in (a password hash set once from the machine itself) with an HttpOnly, SameSite=Strict session cookie. It protects every route, **including the event stream**. Approvals require signing in again within the last 5 minutes. |
| 3 | Server start-up | Binds only to the Tailscale address (or a LAN address you choose), never `0.0.0.0`. HTTPS through `tailscale cert`. |
| 4 | `scripts/service/**` | Starts the server and runner headless as a service (systemd, launchd or a Windows service, depending on the mini PC's OS), so runs continue with no app open |
| 5 | `src/components/agents/**` | Run list and run detail laid out for a phone (§10A idea 9) |
| 6 | Tests | Refuses to start in the forbidden combinations. Unauthenticated event stream → 401. An approval with an old sign-in → refused. Binding to `0.0.0.0` → refused. |

### 16.6 AW.6 (candidate) — A container sandbox per project

| # | Files | What |
| ---: | --- | --- |
| 1 | `src/core/agents/sandbox/**` | Optional, per project: Claude Code and Codex runs execute in a Docker or Podman container with only the worktree mounted. Network access follows the project policy. |
| 2 | Probe | Detects the container runtime. Antigravity is excluded until it can sign in inside a container. |
| 3 | Tests | A write outside the mount fails. Network access with "no network" fails. Without a runtime, the setting is unavailable, never silently ignored. |

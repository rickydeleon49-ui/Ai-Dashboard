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

## 2. Decisions needed before any code

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
| `-c model_reasoning_effort="<level>"` | Effort. **Still to verify:** the help output does not list the config key, so the probe confirms it is accepted before the run starts. If it is not, the run is refused instead of running at a different effort. |
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
- The login-status command (likely `codex login status`), which the probe uses to report "authenticated: yes/no" without reading `~/.codex`
- Confirmation that `-c model_reasoning_effort="medium"` is accepted, for example with `codex exec --strict-config -c model_reasoning_effort="medium" -s read-only "reply OK"` in a scratch Git repository

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
| `--mode plan` | Planner or reviewer, if Antigravity is ever used in those roles. These roles read and never edit. |
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
3. **What happens under `accept-edits` when a turn needs a shell command (a build or tests).** Does it fail, skip the command or wait for input? Waiting would hang an unattended run. The runner runs the checks itself (§7), so the implementer may not need a shell at all. This test decides that.
4. **What `--project` / `--new-project` do.** Antigravity has its own project concept. The adapter must not create or change Antigravity projects as a side effect, unless that turns out to be how a working directory is chosen.
5. **The stream-json event shape**, which the event mapping and the fake agent fixture are built from.

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
  "Next roadmap task" (enabled only when the project has a roadmap source), role
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

## 11. Release plan

Each release is a separate PR and is independently testable.

| Release | Contents | Done when |
| --- | --- | --- |
| **AW.1 — Vertical slice** | Schema, runner process, Git worktree workspaces, Claude Code as implementer, runner-owned checks and diff, **single-pass review by Claude** (separate session), SSE with replay, Stop, restart → `interrupted`, `/agents` and run-detail pages, and a scripted **fake agent CLI** for tests and the demo | select project → choose implementer → submit → watch → inspect diff and verdict, demonstrated on a synthetic temp project |
| AW.2 — Codex roles + corrections | Codex adapter (after the help/flag probe on your Mac) as planner and reviewer, structured planner and reviewer JSON, up to 3 correction rounds | Correction loop proven with the fake agent emitting findings |
| AW.3 — Antigravity + LM Studio | Antigravity implementer adapter (headless mode confirmed, §3.2), after the smoke tests in §3.2 pass. LM Studio advisory summaries. | Probe-driven availability, never a silent fallback |
| AW.4 — Policy, resume, non-Git, approvals | Per-project policy editor, exclusions and test restrictions, non-Git snapshot strategy, explicit Resume, approval-gated merge, push and apply-back | Approval gates covered by tests |

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
   - ~~`codex exec --help`~~ **Done** (§3.1). ~~`codex --version`~~ **Done** (0.160.0). Still needed: the login-status command and the effort-key check in §3.1. **Repeat the Claude and Codex checks on the Windows machine as well**, since availability is probed per machine (§5A).
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
| 6 | `src/core/agents/workspace.ts`, `src/core/agents/roots.ts` | Workspace roots, the worktree root and run-control storage as per-machine settings (§5). Worktree create and remove inside Command Center's own subfolder only, realpath containment checks against the roots, a drive-missing check, lock acquire and release, and the `git diff base...HEAD` summary. |
| 7 | `src/core/agents/process.ts`, `src/core/agents/resolve-executable.ts` | Spawn with `shell: false` from a resolved executable (no `.cmd` shims, §5A), and record the PID and process group. Stop: on macOS, SIGTERM then SIGKILL to the group; on Windows, `taskkill /T` then `/T /F`. Output goes through the existing `ndjson.ts` parser. |
| 8 | `src/core/agents/adapters/claude-code.ts`, `adapters/fake.ts` | `probe()`, `buildArgv()` (asserted to never include a bypass flag), the per-run `--settings` grant file, and stream-json → events |
| 9 | `src/core/agents/orchestrator.ts` | The stage machine in §7. The final status is computed only from facts the runner observed. |
| 10 | `runner/index.ts` (+ `npm run runner`) | Claims intents, runs the orchestrator, epoch-based recovery at startup |
| 11 | `desktop/main.js` | Forks the runner next to the server, passes the run-storage path, and stops it on quit |
| 12 | `src/app/api/agent-runs/**` | `POST` creates a start intent, `POST /:id/stop` creates a stop intent, `GET /:id` returns the run, and `GET /:id/events` streams SSE with `Last-Event-ID` replay. All of them return 404 when the feature is disabled. |
| 13 | `src/app/agents/**`, `src/components/agents/**`, `src/config/navigation.ts` | Run form, history, run detail (timeline, events, diff, checks, verdict, Stop) |
| 14 | `tests/unit/agent-*.test.ts`, `tests/fixtures/fake-agent.mjs` | The test plan in §12 |
| 15 | `scripts/agents-demo.ts` (+ `npm run agents:demo`) | Disposable synthetic project + temp database, end to end with the fake agent |
| 16 | `README.md`, this note | Setup, usage, validation results, and the limitations that remain |

AW.1 is done when `typecheck`, `lint` and `test:unit` pass, the demo runs
cleanly, and the PR is open for independent review **without being merged**.

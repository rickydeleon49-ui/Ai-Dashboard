# Command Center

A personal project operating system — one place to see, organise, launch and
manage everything you work on: GitHub repositories, uploaded projects, manual
projects, and eventually AI workflows.

**Runs as a desktop application** (macOS, Windows, Linux) and as a web app from
the same codebase.

Built to be extended for years, not to be a throwaway dashboard.

## Download

Get the latest installer from the
[Releases page](https://github.com/rickydeleon49-ui/Ai-Dashboard/releases/latest):

| Platform | File |
| --- | --- |
| Windows (x64) | `Command.Center-<version>-win-x64.exe` |
| macOS (Apple silicon) | `Command.Center-<version>-mac-arm64.dmg` |
| Linux (x86_64) | `Command.Center-<version>-linux-x86_64.AppImage` |

Or build from source with the quick start below.

---

## Quick start — desktop

```bash
npm install
npm run desktop:dev     # starts the dev server and opens the app window
```

Building an installer for the machine you are on:

```bash
npm run desktop:package     # -> release/
```

No compiler or build tools are required — the one native dependency ships
Node-API binaries that work unmodified in both Node and Electron.

Installers are platform-specific, so a Windows `.exe` must be produced on
Windows and a macOS `.dmg` on macOS. The **Desktop build** GitHub Actions
workflow does this on hosted runners: run it from the Actions tab, pick a
platform, and download the installer from the run's artifacts.

The Windows installer is per-user (no admin prompt) and creates a desktop
shortcut and Start Menu entry named **Command Center**.

## Quick start — web

```bash
npm install
npm run db:migrate      # create the SQLite database
npm run db:seed         # optional: a small starter library
npm run dev             # http://localhost:3000
```

## Where your data lives

The desktop app stores everything in the standard per-user application data
directory, so it survives app updates and reinstalls:

| Platform | Location |
| --- | --- |
| macOS | `~/Library/Application Support/Command Center/data` |
| Windows | `%APPDATA%\Command Center\data` |
| Linux | `~/.config/Command Center/data` |

**File → Open Data Folder** opens it. Back that folder up and you have backed up
your entire library. Running the web version instead uses `./data`, or whatever
`DATABASE_PATH` points at.

## Connecting GitHub

The dashboard ships with a **real** GitHub client. Without credentials it runs on
a clearly-labelled demo set so the hub is explorable immediately.

**Paste a token.** Settings → GitHub → paste a personal access token → Sync. It
takes effect immediately, with no restart. A classic token needs the `repo`
scope; a fine-grained token needs repository access plus **Contents: Read** and
**Metadata: Read** — fine-grained tokens grant nothing by default, so both must
be set explicitly.

**Or connect an account.** Paste an OAuth app Client ID into Settings (or set
`GITHUB_CLIENT_ID`) and Settings gains **Connect with GitHub**: it shows a short
code, you approve it in the browser, and the connection completes — no token to
create, no permissions to pick.

Create the OAuth App at [github.com/settings/developers](https://github.com/settings/developers).
The callback URL is required by the form but unused (`http://localhost` is fine),
and **Enable Device Flow** must be ticked. Only the Client ID is needed; the
device flow uses no client secret, which is what makes it safe for a desktop
application.

Repositories are cached locally. Press **Add** on any repository to make it a
first-class project on your dashboard. Re-syncing refreshes upstream metadata
without touching your own edits.

Phase 2 replaces the token with a full OAuth flow — the interface does not change.

## What is here now

- **Dashboard** — totals, active work, recently opened, favorites, activity feed,
  quick actions, status breakdown
- **Unified project library** — GitHub, uploaded and manual projects in one
  searchable, filterable place
- **Search** across names, descriptions, notes, repository URLs and tags
- **Filters** for source, status, tag, sort and archived — all URL-driven, so any
  view is shareable and bookmarkable
- **Project detail** — one reusable page for every source, with Open Project,
  Open GitHub, Issues, Pull Requests, Projects and Copy URL
- **GitHub hub** — connection status, sync, repository cards, add to dashboard
- **Manual projects** — full create/edit/archive/delete
- **Uploads** — create a project from files, or attach files to any project
- **Favorites**, **tags**, **notes**, **activity tracking**
- **Local AI** — your own models through Ollama, project-aware, with streaming,
  cancellation and saved conversations
- **Agent runs** (desktop app only) — start a coding agent on a project in its own
  Git worktree, watch its output live, and review the result (see below)
- **Command palette** — `⌘K` / `Ctrl+K` over projects, actions and pages
- **Dark, light and system themes**, responsive from phone to wide desktop

**Tools** and **Notes** exist as routes with their database tables already
migrated, but they are not in the sidebar until they do something: a navigation
full of entries that lead to a description of a future page costs a click to find
that out every time. The routes still resolve, so links and bookmarks keep
working.

## Local AI

Command Center runs your own models, on your own machine, through
[Ollama](https://ollama.com). Nothing leaves the computer.

Install Ollama and pull a model:

```bash
ollama pull qwen3:8b
```

Then open **Local AI** in the sidebar. There is nothing else to configure — the
model list is read from your Ollama installation, so whatever you have pulled is
what you can pick.

**Startup.** When the desktop app launches it checks whether Ollama is already
answering on `http://127.0.0.1:11434`. If it is, that instance is used. If not,
Command Center starts one. An Ollama that was already running is never stopped
when you close the app; only one Command Center started itself is.

**Models are loaded lazily.** Starting the service costs nothing; loading an 11 GB
model costs 11 GB of VRAM. So the sequence is: app starts → status becomes
**Ready** → your first message loads the model you selected. Turn on *Preload the
default model* in Settings if you would rather pay that at launch. Idle unloading
uses Ollama's own `keep_alive`, set from the idle-timeout preference.

**Projects.** Any project has **Open in AI Workspace**, which points the
conversation at it. The model is told the project's name, kind, status, tags,
folder, repository and current git branch — never the contents of your files
unless you attach them.

**Attaching files.** With a project selected, the paperclip beside the composer
lists that project's uploaded files. Tick the ones a question is about and they
ride along with that one message: up to eight files, 96KB of each and 384KB in
total, with anything that is not text refused rather than pasted in as noise. The
selection clears once it has been sent, so a long conversation does not quietly
re-send the same files every turn, and each message records what went with it so
the transcript still reads correctly after a reload. A file can only be attached
to a conversation pointed at the project that file belongs to.

**Chat and Agent.** Chat mode talks to your local model and has no ability to
read files or run commands. Agent mode is the seam for Hermes Agent workflows:
Command Center detects whether Hermes is installed and shows the approval rules
an agent will run under, but it does not execute agent workflows yet — and it
will not pretend to by answering with the chat model instead.

**Approval rules.** The rules in Agent mode are editable, and they are the policy
the agent seam is evaluated against rather than a description of one. Reading is
automatic, writing and running ask first, pushing is blocked. Setting **Run a
command** to *Blocked* stops Agent mode from starting Hermes at all — the status
line says so, and the request is refused before the executable is even looked
for.

Settings → **Local AI** has the connection diagnostics: status, API URL,
installed models, what is currently in memory, a test button, and the last error.

## Agent runs (desktop)

The **Agents** page lets you give a coding agent a task on one of your projects
and follow it from start to finish:

- Each run gets its **own Git worktree and branch**, so your working copy is
  never touched.
- The run page shows a **timeline**, a **live terminal panel** with the agent's
  output, the files it changed, check results, and a verdict. **Stop** ends a
  run at any time.
- **Settings → Agents** shows which agent CLIs were found on this machine and
  where worktrees and run data are stored.

Agents never commit, push or merge. You review the result and decide.

Agent runs exist only in the desktop app. In the web and hosted versions the
pages and API routes return 404.

To see a full run without a real agent, run `npm run agents:demo`. It uses a
fake agent, a throwaway Git project and a temporary database, and cleans up
afterwards.

### Codex as planner and reviewer

Install the Codex CLI and sign in once in your terminal:

```bash
npm install -g @openai/codex
codex login
```

Check your connection with `codex login status`. The **Agents** page runs
`codex --version` and `codex login status` to show whether Codex is installed
and signed in. The app never reads `~/.codex`.

When running as a planner or reviewer, the app runs Codex in a read-only sandbox
in the run's worktree (`-s read-only -C <worktree>`), ignores your user config
(`--ignore-user-config`), and checks the structured output file against a schema
instead of parsing stdout prose. The app never grants full access:
`--dangerously-bypass-approvals-and-sandbox`, `-s danger-full-access`,
`--dangerously-bypass-hook-trust`, `--approve-for-me`, and `--ignore-rules` are
refused. Valid reasoning effort values are `none`, `minimal`, `low`, `medium`,
`high`, `xhigh`, and `max` (default `medium`). Codex cannot edit files in these
roles, and it cannot be the implementer.

Models offered: `gpt-6.1-sol` (default) and `gpt-6-luna`. When Codex is
installed and signed in, the run form defaults the planner and reviewer to
Codex `gpt-6.1-sol` with `medium` effort.

### Antigravity as implementer

Antigravity (`agy` CLI 1.5.3+) can be the implementer only; planner and reviewer
stay Claude Code / Codex. It has no sandbox, so the runner watches every tool
call: any read or write outside the project folder stops the run at once and the
run fails ("stopped by tool monitor"). One exception: reading a plugin's
`SKILL.md` under `~/.gemini/config/plugins` is allowed and shown on the run page
as "plugin file read (allowed)".

Before the first Antigravity run the form lists the Antigravity plugins and MCP
servers on this computer; tick "I reviewed these plugins and MCP servers". If
the list changes later you are asked again. If Antigravity ends a stage without a
result, the runner continues the same conversation up to 2 times, then the run
fails.

### Local advisor (LM Studio)

The advisor is optional and off by default. Turn it on by starting the
dashboard with `DASHBOARD_ADVISOR=1` (set `DASHBOARD_ADVISOR_URL` if LM Studio
is not on http://127.0.0.1:1234), and load a model in LM Studio (Gemma 4 12B
suggested). After the final verdict it writes a short summary marked "advisory
only". It never changes whether the run passed. If LM Studio is offline the run
page says "advisor unavailable".

Cost per run: Antigravity uses your Google AI plan quota; the advisor is local
and free; the Claude reviewer costs the same as before.

### Role settings

Each run has a planner, implementer, and reviewer, each with provider, model,
and reasoning effort.

The reviewer label reflects how independent the review is:
- **Different provider** — a different provider reviews the implementer's work.
- **Same provider, separate session** — same company's model in a fresh
  session: a second look, but not fully independent.
- **No independent review** — no reviewer is assigned.

With a planner or reviewer set, a run goes plan → implement → checks → review,
then up to 3 correction rounds. A blocking or major actionable finding, a failed
required check, a change outside the plan scope or a comment you leave on the
current round starts the next round. The run succeeds only when the reviewer
approves, every required check passes and all changes are inside the plan
scope; after round 3 it fails and lists what is still open. The run page has a
round switcher, the plan, and findings grouped as blocking, major and minor.

### Project policy

Each project has a policy, edited on the project's page with the **Agent policy**
button (page `/settings/agents/projects/<id>`). The button shows only in the
desktop app.

- **Checks**: commands the runner runs in the worktree after the agent finishes
  (for example `npm test`). Each has a name, a command, a timeout in seconds,
  and **Required** or informational. A failed required check fails the run; an
  informational one is only shown. Commands run directly, never through a shell,
  so pipes and `&&` do not work; write one check per command. Quote an argument
  that contains spaces with double quotes.
- **Excluded paths**: relative globs (for example `secret/**` or `*.env`) agents
  may not change. Three layers enforce it: Claude Code gets deny rules for them;
  the Antigravity tool monitor stops the run on a write to one (reading is
  allowed); and after the run, any changed excluded file is listed and fails the
  run.
- **Shared folders**: folders such as `node_modules` to link into each run's
  worktree instead of installing them again. They would be shared, so an agent
  could change what is inside them; the page warns about this. The list is saved
  now; linking it into worktrees is not switched on yet.

Saving checks the whole policy; problems are listed one per line and nothing is
saved until they are fixed.

### Projects without Git

A project folder that is not a Git repository is copied into the worktree
folder first (`<worktree root>/command-center/snap/<run>/base`), skipping
excluded paths, links, and heavy folders (`node_modules`, `.venv`, `venv`,
`__pycache__`, `.next`, `dist`, `build`, `.git`, `.DS_Store`). The copy becomes
a throwaway Git repository and the run works in a worktree of it, so the run
page, diff and review look the same as for a Git project.

The copy is refused above 50,000 files or 2 GB.

Your original folder is not changed by the run. Copying the result back is a
separate step that needs your approval. Before writing, it checks that none of
the affected files changed in your folder since the copy was made (if one did,
nothing is written), makes a timestamped backup of every file it will overwrite
or delete (with a `manifest.json`), copies only the changed files, then checks
each file's hash. If a check fails, your files are restored from the backup.
Copy back from the run's **Approvals** card (see Run approvals below).

### Runs linked to a task

A run can be tied to one task of its project. **Next task** in the run form
fills in the next eligible task from the project's task board (open, not blocked,
and with no active run); **Clear** removes it.

When the run ends, one entry is added to the task's activity with the result, a
link to the run, the check counts and the review verdict.

A run never changes the task itself: status, priority and dates stay as you set
them.

### Run approvals

After a run finishes (succeeded, failed or stopped), its page has an
**Approvals** card. Nothing below happens without your approval.

Each action has three steps: **Preview** shows exactly what will happen; then
**Approve** or **Reject**; after approval the runner does it in the background,
and the result (or the error) is shown and added to the run's event log.

Actions:
- **Merge into a branch**: merges the run branch into the branch you name. That
  branch must be the one checked out in your project folder; the app never
  switches your checkout. Refused if your checkout has uncommitted changes or
  the preview found conflicts. The merge commit uses your own Git name.
- **Push branch**: pushes the run branch to a remote (default `origin`). Never a
  force push.
- **Open draft pull request**: opens a draft pull request on GitHub with the
  GitHub token from Settings. The body lists the run's checks, review and
  changed files. The app never merges a pull request.
- **Copy results back to your folder**: for projects without Git only; this is
  the copy-back step described in "Projects without Git", with its backup and
  checks.
- **Delete worktree**: removes a run's worktree even when its branch has commits
  that are not merged. The branch itself is kept.

Before running an approved action the runner checks again: if the run branch or
your branch moved since the preview, it stops and asks for a new preview. Each
run has at most one open approval per action.

## Commands

| Command | Does |
| --- | --- |
| `npm run desktop:dev` | Desktop app against a hot-reloading dev server |
| `npm run desktop:build` | Build the bundle the desktop app ships |
| `npm run desktop:package` | Build an installer for the current platform |
| `npm run dev` | Web development server |
| `npm run build` / `npm start` | Web production build and serve |
| `npm run typecheck` | TypeScript, no emit |
| `npm run lint` | ESLint |
| `npm run db:generate` | Generate a migration after a schema change |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:seed` | Seed a starter library (skips if data exists) |
| `npm run db:reset` | Delete the database, migrate and reseed |
| `npm run agents:demo` | One full agent run with a fake agent, in a temp folder |

Migrations also run automatically on first request, so a fresh clone or a fresh
Railway volume works without a manual step.

## Configuration

All optional — see `.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_PATH` | `./data/dashboard.db` | SQLite file location |
| `UPLOADS_DIR` | `./data/uploads` | Uploaded files (Phase 3) |
| `GITHUB_TOKEN` | — | Personal access token for live repository data |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | — | OAuth app (Phase 2) |
| `DASHBOARD_PASSWORD` | — | **Required** for any single-password hosted deployment (see below) |

Hosted multi-user mode (`AUTH_MODE=accounts`) has its own set of variables —
see the section below.

## Deploying to Railway (optional)

The desktop app is self-contained, but the same codebase still deploys as a web
service — useful if you want the library reachable from a phone or another
machine.


1. Create a service from this repository. Railway detects Next.js; the start
   command is `npm start` and the app binds `$PORT`.
2. Add a **volume** mounted at `/data`.
3. Set service variables:
   ```
   DATABASE_PATH=/data/dashboard.db
   UPLOADS_DIR=/data/uploads
   GITHUB_TOKEN=...
   ```

The volume is what makes your library survive redeploys. Without it, SQLite lives
on ephemeral container disk.

## Hosted, multi-user mode (accounts & workspaces)

Everything above this line describes the single-password deployment, where
anyone with the password has full access to one shared library. An opt-in
alternative gives every person their own account and lets teams share a
**workspace** instead: `AUTH_MODE=accounts`.

**What you get.** Sign in with GitHub or an emailed magic link. A personal
workspace is created for you automatically. Create a team workspace, invite
teammates by email at a role (`admin` / `member` / `viewer`), and switch
between the workspaces you belong to from Settings. A `viewer` can look but
not edit; only an `admin` or `owner` can invite.

**Only Dashboard, Projects, Favorites and Settings are reachable.** Every
other page and API route (AI workspace, uploads, prompts, automations,
GitHub sync, notes, notifications, integrations, tools) is deliberately
blocked (404) in this mode — see [docs/OVERVIEW.md](docs/OVERVIEW.md#2b-hosted-multi-user-mode-opt-in-auth_modeaccounts)
for why.

**Setup:**

1. Provision a Postgres database and set `DATABASE_URL`.
2. Run the Postgres migrations: `npm run db:migrate:pg`.
3. Set `AUTH_MODE=accounts` and `AUTH_SECRET` (generate one with
   `openssl rand -base64 32`).
4. Configure at least one sign-in method:
   - **GitHub OAuth** — create an OAuth App at
     [github.com/settings/developers](https://github.com/settings/developers)
     with callback URL `<your-url>/api/auth/callback/github`, then set
     `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`.
   - **Email magic link** — set `EMAIL_SERVER` (an SMTP connection string)
     and `EMAIL_FROM`. Without these, the magic link is logged to the server
     console instead of emailed — usable for local testing, not for a real
     deployment.
5. Redeploy.

**Upgrading an existing single-password deployment.** Keep
`DASHBOARD_PASSWORD` set alongside the new variables above, redeploy, sign
in, then go to **Settings → Claim legacy data** and enter the deployment's
dashboard password. This is a one-time action — it imports that
deployment's existing SQLite projects and tags into your own workspace,
leaves the SQLite data untouched, and cannot be repeated by a second
account once it succeeds.

See `.env.example` for every variable and `docs/OVERVIEW.md` §2b/§7 for how
route restriction, workspace resolution and role checks fit together.

## Architecture

Start with **[docs/OVERVIEW.md](docs/OVERVIEW.md)** — what the app does, the
stack, the layer map, how a request flows, the data model, the security model
and the current rough edges, in one file.

Then **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the reasoning behind
each decision: the provider seam, the phase plan, and a quick reference for
adding new sections, fields and integrations.

The short version:

```
desktop/      Electron main process, preload bridge, build scripts
app/          Routes — thin
components/   ui/ primitives, then feature folders
core/         Domain: types, validation, logic, integrations (no framework)
db/           Schema, client, repositories behind an interface
config/       Navigation and quick actions as data
```

Dependencies point downward only. `db/repositories/index.ts` is the single place
that names a concrete database implementation — swapping SQLite for Postgres later
is one new class and one changed line.

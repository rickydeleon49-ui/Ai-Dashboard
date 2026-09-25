# Command Center — what it does and how it is built

A map of the whole application in one file: the features that exist today, the
stack underneath them, and how a request travels from a click to SQLite and
back.

For the rationale behind each decision, see
[ARCHITECTURE.md](ARCHITECTURE.md). For installing and running it, see the
[README](../README.md). This document is the middle layer between the two.

---

## 1. What it is

A personal project operating system: one place to see, organise, launch and
keep track of everything you work on — GitHub repositories, uploaded archives,
and manual projects — plus a prompt library and a small automation runner.

It is **single-user by design in its default and desktop forms** — one password
on hosted deployments and nothing at all on the desktop, because the desktop
server is unreachable from off the machine. An opt-in third mode,
`AUTH_MODE=accounts`, adds real per-user sign-in and team workspaces on top of
the same codebase (§2b and §7); everything in this document that doesn't say
otherwise describes the single-user forms, which remain entirely unaffected
whether or not accounts mode exists elsewhere.

One codebase ships to three targets:

| Target | What it is | Storage | Auth |
| --- | --- | --- | --- |
| **Desktop** (primary) | Electron window wrapping the bundled Next.js server on `127.0.0.1:<random>` | OS user-data directory | none — not network reachable |
| **Web, single-password** (optional) | The same app served by `next start`, e.g. on Railway | `./data`, or a mounted volume | HTTP Basic via `DASHBOARD_PASSWORD` |
| **Web, hosted accounts** (optional, `AUTH_MODE=accounts`) | The same app, real per-user sign-in and workspaces | Postgres (`DATABASE_URL`) | Auth.js session (GitHub OAuth or email magic link) |

The application is primarily TypeScript/JavaScript across `src/` and `desktop/`, with
ten runtime dependencies.

---

## 2. What it does today

### Projects — the core

- **Unified library** at `/projects`. GitHub, uploaded and manual projects share
  one card, one detail page and one query path; source-specific detail (language
  dot, stars, private lock) renders only when the data is there.
- **Search** across names, descriptions, notes, repository URLs and tags.
- **Filters** for source, status, type, tag, sort and archived. All filter state
  lives in the URL, so any view is shareable, bookmarkable and survives reload —
  `buildProjectQuery()` (`src/core/projects/query.ts`) turns search params into a
  repository query, and every listing page reuses it.
- **Lifecycle**: `idea → planning → active → paused → …` as a status enum,
  plus favourites, archive/restore, tags, notes and per-project activity.
- **Recently opened** — opening a project stamps `lastOpenedAt`
  (`POST /api/projects/:id/open`), which drives the dashboard's recent list.
- **Local project actions** (desktop only) — a project with a `localPath` gets
  **Open folder**, **Editor** and **Terminal** buttons on its detail page. The
  renderer sends a project id and an action name, never a path; the Electron main
  process resolves the path itself and launches with an argv array, never a
  shell string. In a browser there is no bridge, so the path renders as plain
  text rather than offering a button that cannot work.

### Milestones, tasks & My Work (`/projects/:id/tasks`, `/my-work`)

- **Per-project planning**: milestones and tasks, one level of subtasking (the
  schema allows more, the UI renders one), status and priority, due dates — a
  plain list (milestones as grouping headers, tasks nested under them), not a
  board or calendar; those need Table/Board/Calendar primitives this app
  doesn't have yet.
- **Dependencies**: a task can depend on any other task in the same workspace.
  Adding one that would create a cycle (directly or transitively) is rejected;
  a task with an unfinished dependency shows as **Blocked** — computed fresh
  from the dependency graph on every read, never stored, so it can never drift
  out of sync.
- **My Work** (`/my-work`) — every task across every project in your current
  workspace, filtered to your own assignment in hosted accounts mode (there is
  no assignee concept on desktop, so it's every task in the one workspace that
  exists there); filterable by status, priority and project, with a quick
  status-change control per row.
- The project detail page's **Milestones & tasks** card is the real "project
  overview" this covers: task/done/overdue/blocked counts and upcoming
  milestones. GitHub issues/PRs, deployment status, uptime and business
  metrics are a later release's work, not this one's.

### Knowledge base (`/projects/:id/knowledge`)

- A flat, per-project list of plain-text documents — title, content, an
  optional free-text category, and a **pinned** flag that keeps a document
  at the top of the list. No folders/hierarchy, no markdown rendering, no
  version history in this first slice.
- **Search** across title, content and category — the content is the point
  of a document, so it's covered too, not just the title (same reasoning
  as the prompt library's own search).
- The project detail page's **Knowledge base** card shows the document
  count plus pinned/recently-updated titles, linking into the full list —
  same shape as the Milestones & tasks card above.

### Dashboard (`/`)

Totals and status breakdown, active work, recently opened, favourites, an
activity feed and quick actions — all server-rendered from a handful of parallel
repository queries.

### GitHub (`/github`)

- A real REST client with bearer-token auth and pagination, plus a clearly
  labelled demo provider so the hub is explorable before anything is connected.
- Two ways to connect: paste a personal access token in Settings, or use the
  **device flow** (`Connect with GitHub`) with only a public client id.
- Repository metadata is cached in its own table and **synced** on demand or on a
  schedule. Pressing **Add** links a repository to a first-class project;
  re-syncing refreshes upstream metadata and never touches your own edits.
- A stale or revoked token degrades to demo data with GitHub's own error message
  preserved, instead of breaking the page.

### AI (`/ai`, `/ai/prompts`)

A prompt library with full CRUD, search across titles *and* bodies, categories
and favourites; a workspace collecting AI-typed projects, recent prompts and
one-click links to the assistants you already use. No AI provider is wired in —
nothing on these pages sends data anywhere.

### Automations and notifications (`/ai/workflows`, `/notifications`)

A task catalogue in code (`src/core/automation/tasks.ts`), schedules in the
database, an in-process scheduler and an unread notification inbox. Shipped
tasks: **Sync GitHub repositories** and **Flag stalled projects**.

This is deliberately not cron. A desktop app has no always-on server, so the
scheduler ticks while the app is open (first tick at 15s, then every 60s), and
due-ness is computed from `lastRunAt` rather than a live timer — anything that
fell due while the app was closed runs shortly after it reopens. The Automations
page says exactly that rather than implying background execution.

### Everything else

Settings (GitHub token/client id, theme, update check), Integrations, a command
palette on `⌘K`/`Ctrl+K` over projects, actions and pages, dark/light/system
themes, and an update check that reports a newer release and links to it rather
than installing it.

---

## 2b. Hosted, multi-user mode (opt-in, `AUTH_MODE=accounts`)

Real per-user accounts and team workspaces, on top of the same codebase —
requires `DATABASE_URL` (Postgres) in addition to `AUTH_MODE=accounts`; see
`.env.example` and README's **Hosted, multi-user mode** section for the full
setup. Sign in (GitHub OAuth or an emailed magic link) and a personal
workspace is created automatically on first sign-in
(`src/auth.ts`'s `events.createUser`, self-healing on every request after —
see ARCHITECTURE.md §7b).

- **Workspaces.** Everyone gets a personal workspace; anyone can also create a
  team workspace and switch between the workspaces they belong to (Settings).
  A workspace always has at least one **owner** — a database trigger, not just
  application logic, rejects whatever would remove the last one.
- **Roles.** `owner` > `admin` > `member` > `viewer`, checked fresh from
  `workspace_member` on every mutating request — never trusted from a session
  claim, a cookie, or the mere fact of being signed in.
- **Invitations.** An admin or owner invites by email at a role below owner;
  accepting requires the signed-in email to match the invited one exactly
  (case-insensitively), is single-use, and expires after 7 days.
- **Claiming an existing single-password deployment.** A one-shot flow
  (Settings → *Claim legacy data*, `POST /api/ownership-claim`) lets exactly
  one signed-in account import that deployment's existing SQLite projects and
  tags into their own workspace, proven to be the operator by also supplying
  the deployment's `DASHBOARD_PASSWORD`. The source SQLite data is only ever
  read, never modified, and a second claim attempt always fails.
- **Only Projects, Favorites, Dashboard, Settings, Milestones/Tasks,
  Knowledge base and My Work are reachable.** Every other domain — AI
  workspace, uploads, prompts, automations, GitHub sync, notes,
  notifications, integrations, tools — still reads and writes the
  SQLite-only tables described in §6, which were never given a workspace
  column. Reaching them in accounts mode would show every signed-in user
  the same shared, unscoped data regardless of workspace, so `proxy.ts`
  404s them outright rather than exposing them half-scoped (§7, §11). They
  get ported for real in a later phase. Knowledge base needed no new
  `proxy.ts` entry at all — every route is nested under `/projects`/
  `/api/projects`, which the allowlist already covers.

---

## 3. Stack

| Layer | Choice |
| --- | --- |
| Framework | **Next.js 16**, App Router, React 19, Server Components by default |
| Language | **TypeScript**, `strict` + `noUncheckedIndexedAccess` |
| Database | **SQLite** (better-sqlite3, WAL, foreign keys on) via **Drizzle ORM** + drizzle-kit migrations |
| Validation | **Zod** — one schema shared by forms, API routes and integration payloads |
| Styling | **Tailwind CSS v4**, design tokens as CSS variables in `globals.css` |
| Icons | `lucide-react` |
| Desktop | **Electron 44** + electron-builder (dmg / nsis / AppImage) |
| Tests | Node's built-in `node:test` driving **Playwright**'s Chromium — no test runner dependency |

`"use client"` appears only where there is genuine interactivity: the command
palette, filters, forms and toggles. Everything else renders on the server and
queries SQLite directly, with no API round trip.

---

## 4. Layers

Dependencies point **downward only** — a layer never imports from the one above.

```
desktop/      Electron main process, preload bridge, build scripts
   ↓
src/app/      Routes. Thin: fetch, compose, render.
   ↓
src/components/   ui/ primitives, then feature folders
   ↓
src/core/     Domain: types, validation, logic, integrations (no framework)
   ↓
src/db/       Schema, client, repositories behind an interface
```

```
src/
  app/                Routes and API handlers
  components/
    ui/               Button, Badge, Card, Field, EmptyState, PageHeader, PhasePage
    layout/           AppShell, Sidebar, CommandPalette, ThemeToggle, DesktopBridge
    projects/         Card, filters, forms, actions, files, local actions
    tasks/            project tasks board, My Work filters/list
    knowledge/        document card, filters, form
    dashboard/        StatTiles, QuickActions, ActivityFeed, ProjectRowList
    prompts/ github/ automation/ settings/
  core/
    projects/         types · schema (Zod) · labels · query
    tasks/            milestone/task types · schema (Zod) · labels · errors
    knowledge/        knowledge document types · schema (Zod)
    github/           provider interface · REST · demo · device flow · service
    automation/       tasks · scheduler · service · notifications
    files/ storage/   upload service + StorageDriver (local-disk implementation)
    prompts/ activity/ settings/ updates/
  db/
    schema.ts         Drizzle tables
    client.ts         one cached connection per process
    repositories/     interface · Drizzle implementation · composition root
  config/             navigation.ts, quick-actions.ts, app.ts — surfaces as data
  proxy.ts            auth + CSRF for the whole app
```

Two seams carry most of the extensibility:

- `db/repositories/index.ts` is the **only** file that names a concrete database
  implementation. Repository methods are `async` even though better-sqlite3 is
  synchronous, so swapping in Postgres or a hosted API is one new class and one
  changed line.
- `core/storage/driver.ts` does the same for uploaded bytes: local disk today,
  object storage later, without touching call sites.

`config/navigation.ts` and `config/quick-actions.ts` are plain arrays — adding a
sidebar section is one entry plus a route file, with no component edits.

---

## 5. How a request flows

**A page render** (the common path):

```
Browser → middleware (auth + CSRF)
        → Server Component (app/projects/page.tsx)
        → buildProjectQuery(searchParams)      core/projects/query.ts
        → projectRepository.list(query)        db/repositories/index.ts
        → Drizzle → better-sqlite3 → dashboard.db
        → HTML
```

No client-side data fetching is involved; changing a filter changes the URL,
which re-runs the Server Component.

**A mutation** goes through a route handler under `app/api/`, which validates
with the Zod schema from `core/`, calls the repository, and records an activity
event. The client component then refreshes the route.

**API surface** (all JSON, all under `/api`):

| Area | Endpoints |
| --- | --- |
| Projects | `GET/POST /projects`, `GET/PATCH/DELETE /projects/:id`, `POST /projects/:id/open` |
| Milestones | `GET/POST /projects/:id/milestones`, `GET/PATCH/DELETE /projects/:id/milestones/:milestoneId` |
| Tasks | `GET/POST /projects/:id/tasks`, `GET/PATCH/DELETE /tasks/:id`, `GET/POST/DELETE /tasks/:id/dependencies` |
| My Work | `GET /my-work` |
| Knowledge base | `GET/POST /projects/:id/knowledge`, `GET/PATCH/DELETE /projects/:id/knowledge/:docId` |
| Files | `GET/POST /projects/:id/files`, `GET/DELETE /files/:id` |
| Prompts | `GET/POST /prompts`, `GET/PATCH/DELETE /prompts/:id` |
| GitHub | `POST /github/sync`, `POST/DELETE /github/link`, `GET/POST /github/device` |
| Automations | `GET /automations`, `PATCH /automations/:id`, `POST /automations/:id/run` |
| Notifications | `GET/POST/DELETE /notifications` |
| Settings | `PUT/DELETE /settings/github-token`, `PUT/DELETE /settings/github-client-id` |
| Updates | `GET /updates` |

---

## 6. Data model

`projects` is the centre; everything else references it.

```
projects ──┬── project_tags ── tags
           ├── project_files            uploads (named on disk by generated id)
           ├── activity_events          the feed — append-only history
           ├── notes
           ├── github_repositories.linked_project_id
           ├── knowledge_documents      flat, plain text, pinned flag
           └── milestones ── tasks ── task_dependencies (task_id, depends_on_task_id)
                              └── tasks (parent_task_id — one level of subtasking)

settings        key/value: GitHub token, token origin, OAuth client id
automations     one row per registered task: interval, enabled, last run/status
notifications   unread inbox produced by automations
prompts         the prompt library
```

Three things are worth knowing:

1. **`metadata` (JSON) is the escape hatch.** New fields start there with no
   migration — the GitHub sync uses it for stars, language and default branch.
   A field earns a column when it is queried or filtered often, and a table when
   it has its own lifecycle.
2. **`github_repositories` mirrors the GitHub API, not the Project model.** That
   separation is what makes a resync safe: upstream metadata is refreshed in
   place, while your edits live on the linked `projects` row. Demo rows carry an
   `isDemo` flag so cleanup can never delete real cached repositories.
3. **`activity_events` and `notifications` are deliberately separate.** One is a
   log of what happened; the other is a short list of what you have not seen.
4. **A task's `blocked` flag is never stored.** It's computed at read time from
   `task_dependencies` — whether any direct dependency isn't done/cancelled —
   so it can't drift out of sync with the graph or a blocker's own status.
   Checking only the *direct* dependency correctly captures transitive
   blocking too (if B blocks A and B is itself blocked by C, B's status can
   only be todo/in_progress) — but only because `TaskRepository.update()`
   refuses to move a task to `done` while it is itself blocked (409
   `TaskBlockedError`); without that guard a force-completed B would make A
   wrongly report unblocked. Cancelling a blocked task is still allowed.
5. **`knowledge_documents` is flat on purpose.** No parent/folder column —
   grouping is by free-text `category` only, not a tree; hierarchy is
   explicitly deferred, not an oversight (see ARCHITECTURE.md §9).

Migrations live in `drizzle/` and are generated with `npm run db:generate`. They
also run automatically on first request (`src/db/bootstrap.ts`), so a fresh
clone or a fresh Railway volume works with no manual step.

**Hosted accounts mode (§2b) has its own, entirely separate Postgres schema**
(`src/db/schema.pg.ts`, migrations in `drizzle-pg/`, `npm run db:generate:pg` /
`db:migrate:pg`) — Auth.js's own tables, `workspace`/`workspace_member`/
`workspace_invitation`, and workspace-scoped `project`/`tag`/`project_tag`/
`activity_event`/`milestone`/`task`/`task_dependency`/`knowledge_document`
tables mirroring the SQLite ones above but with a `workspace_id` column.
Desktop and single-password hosted mode never connect to Postgres at all.
Full reasoning in ARCHITECTURE.md's `src/db/` section.

**Every migration needs its `meta/NNNN_snapshot.json`, in both folders.**
drizzle-kit plans the next migration by diffing the schema file against the
*last* snapshot; a migration committed without one (hand-written SQL
included) makes the next `db:generate` re-create what it already added. For a
hand-written migration, run `npx drizzle-kit generate --custom` (add
`--config drizzle.config.pg.ts` for Postgres) and put the SQL in the file it
creates, so the snapshot and journal entry come with it. CI runs both
`db:generate` commands and fails if either writes anything, and
`tests/unit/migration-metadata.test.ts` / `tests/unit-pg/migration-metadata.test.ts`
check the snapshot chain, the schema files and a freshly migrated database.
Triggers and functions (Postgres 0002, 0010, 0011) are not in snapshots; their
migration tests cover them.

---

## 7. Security model

**Desktop.** The bundled server binds `127.0.0.1` on a random port and sets
`DASHBOARD_LOCAL=1`, which the middleware lets through unauthenticated —
a password there would be friction with nothing behind it.

**Hosted.** Production requires `DASHBOARD_PASSWORD` (HTTP Basic, compared in
length-independent constant time). The default is fail-safe: production with no
password set serves a setup notice instead of the dashboard, so forgetting it
cannot silently publish the library.

**CSRF.** Basic credentials are ambient, so state-changing methods are rejected
when the browser reports the request as cross-site (`Sec-Fetch-Site`, or an
`Origin` whose host does not match). Only positively cross-site requests are
refused — a client sending neither header is not a browser and supplied the
password itself. The same check applies in accounts mode too.

**Hosted, accounts mode (§2b).** Three checks, each independent and each
re-enforced below `proxy.ts` rather than trusted from it alone (a real
vulnerability class in this exact framework, not theoretical caution): a
valid Auth.js session is required for every page and API call except Auth.js's
own routes; only an explicit allowlist of pages/routes is reachable at all
(§2b, §11); and every mutating Projects route re-derives the caller's role
from `workspace_member` fresh (`requireRole()`) rather than trusting session
or cookie state. Full reasoning in ARCHITECTURE.md §7b.

**Renderer isolation.** `contextIsolation: true`, `sandbox: true`,
`nodeIntegration: false`. The preload bridge exposes a minimal surface, outbound
links are intercepted and handed to `shell.openExternal`, and navigation guards
compare parsed origins rather than string prefixes. The desktop test asserts
that `require`, `process` and `module` are all `undefined` in the renderer, so a
regression fails the suite rather than shipping.

**Upload safety.** Uploaded filenames are display data only; files on disk are
named by generated id, so a filename can never become a path.

**Token storage.** The GitHub token is encrypted at rest in the `settings`
table when the app can protect a key for it (a symmetric key wrapped with
Electron's `safeStorage` in the main process, handed to the forked server
once as an env var — no IPC protocol needed, since the server does the actual
AES work itself), and stored plaintext when it can't: hosted mode,
`desktop:dev`, or a system with no OS keyring. ARCHITECTURE.md §7b has the
full design.

---

## 8. The desktop shell

The desktop build wraps the **same application** — it reimplements nothing.

```
Electron main process
  ├─ sets DATABASE_PATH / UPLOADS_DIR → app.getPath("userData")
  ├─ sets DASHBOARD_LOCAL=1
  ├─ fork()s .next/standalone/server.js on a free port
  └─ BrowserWindow → http://127.0.0.1:<port>
```

Four decisions carry it:

- **Storage is environment-driven.** `src/db/path.ts` already read
  `DATABASE_PATH` and `UPLOADS_DIR` (they exist for Railway volumes), so a
  completely different storage location costs zero code changes.
- **Standalone output is conditional** on `DESKTOP_BUILD=1`, because
  `next start` rejects standalone output. One codebase, both targets.
- **asar is disabled.** `fork()` cannot execute a script from inside an asar
  archive, and a native `.node` binary cannot be loaded from one.
- **No native rebuild step.** better-sqlite3 v13 ships Node-API binaries, which
  are ABI-stable across Node and Electron, so `npmRebuild` is `false` and both
  targets share one binary — no Visual Studio Build Tools on packaging machines.
  This is why `engines.node` is `>=22`.

`desktop/build.mjs` also points `DATABASE_PATH` at a temporary directory during
`next build`, because the root layout opens the database at build time and file
tracing would otherwise copy the developer's real database into the installer.

---

## 9. Build, test and ship

| Command | Does |
| --- | --- |
| `npm run desktop:dev` | Desktop app against a hot-reloading dev server |
| `npm run desktop:build` | Build the standalone bundle the desktop app ships |
| `npm run desktop:package` | Installer for the current platform → `release/` |
| `npm run dev` / `build` / `start` | Web development, production build, serve |
| `npm run typecheck` / `lint` | `tsc --noEmit` / ESLint |
| `npm run db:generate` / `migrate` / `seed` / `reset` | Migration workflow |
| `npm test` | Unit, then end-to-end |
| `npm run test:unit` | Fast — no build, no browser |
| `npm run test:e2e` | Builds, boots a real server, drives Chromium |
| `npm run test:desktop` | Launches the real Electron main process |

**Unit tests** cover project queries, archive/restore, file-storage safety,
GitHub sync cleanup, schema validation and the middleware; each gets a throwaway
SQLite database. **End-to-end tests** walk every navigation destination and the
CRUD flows against a real production server, including `withFreshPage` checks in
a new browser context — cold-cache, cross-page navigation is the only shape that
reproduces production-only `<Link>` prefetch bugs (see ARCHITECTURE.md §7c).

**CI**: `.github/workflows/ci.yml` runs typecheck, lint, and the full test
suite (including Postgres and a Windows unit-test job) on every pull
request — the same commands as the table above, so a failure is
reproducible locally with one command. `.github/workflows/desktop.yml`
builds installers on hosted runners — manually from the Actions tab, or for
every `v*` tag. Installers cannot be cross-built, so each platform runs on
its own runner, and macOS is arm64 only because better-sqlite3 downloads a
prebuilt binary for the *building* machine.

**GitHub Actions budget (temporary policy, in effect until lifted):** this
repo has been close to its included Actions minutes for the month, so until
told otherwise, prefer running the table above locally over pushing to see
if CI passes, and batch related work into meaningful pushes rather than
many small ones. `ci.yml` is already built around this: it triggers on pull
requests only (no duplicate run on the `main` push after merge), cancels a
superseded run for the same PR, skips the expensive jobs entirely on
changes that can't affect build/test output via a `plan` job, and checks
one Node version per normal PR (`workflow_dispatch` unlocks the full matrix
on demand). Keep these properties when editing the workflow, and never
remove a required status check, security check, or deployment safeguard to
save minutes — trim scheduling and duplication instead, and don't work
around this by purchasing minutes, raising spending limits, or changing
repository visibility.

---

## 10. Configuration

See `.env.example`. Most settings are optional; hosted production requires
`DASHBOARD_PASSWORD`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_PATH` | `./data/dashboard.db` | SQLite file location |
| `UPLOADS_DIR` | `./data/uploads` | Uploaded files |
| `GITHUB_TOKEN` | — | Personal access token for live repository data |
| `GITHUB_CLIENT_ID` | — | OAuth app client id, enabling the device flow |
| `DASHBOARD_PASSWORD` | — | **Required** for any single-password hosted deployment |
| `DASHBOARD_LOCAL` | — | `1` bypasses auth; set by the desktop shell only |
| `DASHBOARD_DISABLE_SCHEDULER` | — | `1` turns automations off (used by tests) |
| `DESKTOP_BUILD` | — | `1` switches Next to standalone output |
| `DATABASE_URL` | — | Postgres connection string; enables hosted accounts mode (§2b) |
| `AUTH_MODE` | — | `accounts` requires sign-in instead of `DASHBOARD_PASSWORD`; needs `DATABASE_URL` |
| `AUTH_SECRET` | — | **Required** once `AUTH_MODE=accounts` — signs Auth.js's internal tokens |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | — | GitHub OAuth sign-in (accounts mode) |
| `EMAIL_SERVER` / `EMAIL_FROM` | — | SMTP for magic-link sign-in; unset logs the link instead |

Desktop data lives in the standard per-user directory
(`~/Library/Application Support/Command Center/data`,
`%APPDATA%\Command Center\data`, `~/.config/Command Center/data`), reachable
from **File → Open Data Folder**. Back up that folder and you have backed up
everything.

---

## 11. Rough edges

Honest inventory of what is not finished:

- **Workflows are automations.** `/ai/workflows` is the automations screen; there
  is no user-defined workflow builder, and the task catalogue is code, not data.
- **`/notes` and `/tools` exist but are unadvertised.** They are placeholder
  pages, intentionally removed from the sidebar rather than deleted.
- **Updates are checked, not installed** — the repository is private, and
  auto-update would mean shipping a token inside the installer.
- **Hosted accounts mode only ported Projects, Milestones/Tasks and Knowledge
  base.** Uploads, prompts, AI conversations, automations, GitHub sync, notes,
  notifications, tools and integrations are desktop/single-password-only for
  now — genuinely unreachable in accounts mode (§2b, §7) rather than
  half-scoped, until each gets ported for real in a later phase.
- **Knowledge base documents are flat, plain text, with no version
  history.** No folders/hierarchy, no markdown rendering, no revisions —
  a deliberate first-slice scope cut (ARCHITECTURE.md §9), not an
  oversight.
- **No assignee picker or display.** A task's `assigneeId` is a real column
  and the API accepts it, but there's no UI for it — resolving a workspace
  member's id to a name needs a members-list endpoint that returns more than
  `userId`+role (`core/workspaces/service.ts`'s `listMembers()` doesn't), and
  showing a raw id would be worse than not showing one.

---

## 12. Where to add things

| To add… | Do this |
| --- | --- |
| A sidebar section | One entry in `config/navigation.ts` + a route file |
| A quick action | One entry in `config/quick-actions.ts` |
| A project field | `core/projects/types.ts` → `db/schema.ts` → `core/projects/schema.ts` → `npm run db:generate` |
| A milestone/task field | `core/tasks/types.ts` → `db/schema.ts` (SQLite) + `db/schema.pg.ts` (Postgres) → `core/tasks/schema.ts` → `npm run db:generate` + `db:generate:pg` |
| A knowledge document field | `core/knowledge/types.ts` → `db/schema.ts` (SQLite) + `db/schema.pg.ts` (Postgres) → `core/knowledge/schema.ts` → `npm run db:generate` + `db:generate:pg` |
| A new per-project domain | Follow the milestones/tasks or knowledge-base pattern: SQLite table (no `workspace_id`) + Postgres table (`workspace_id` not null) → a `*Repository` interface taking `workspaceId` first → Drizzle + Postgres implementations → wire into `db/repositories/index.ts` → API routes under `app/api/projects/[id]/...` |
| An experimental field | Put it in `metadata`; no migration |
| A status or project type | The const array in `types.ts` + an entry in `labels.ts` |
| A scheduled automation | One entry in `core/automation/tasks.ts`; the row is created on read |
| An integration | A provider interface in `core/<name>/`, resolved in one place |
| A different database | A new `ProjectRepository` + one line in `db/repositories/index.ts` |
| A different file store | A new `StorageDriver` + one line in `core/storage/index.ts` |

The rule that keeps this cheap: **never import values out of a `"use client"`
module from a server component.** Shared constants belong in a plain module both
can import — the one time that was violated, `/settings` failed hydration about
forty percent of the time.

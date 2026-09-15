# Architecture

How this dashboard is put together, and where to add things.

The guiding constraint: **this is meant to be extended for years.** Every decision
below is a bet on making the tenth feature as cheap to add as the first.

---

## 1. Assessment of the starting point

The repository was **empty** — no code, no history, no stack. That made this a
greenfield build rather than an extension, so there was no existing functionality
to preserve. The stack was chosen against the requirements rather than inherited.

## 2. Stack, and why

| Choice | Reason |
| --- | --- |
| **Next.js 16 (App Router)** | GitHub OAuth needs a server to hold the client secret, and uploads need a server to receive files. A React SPA would have to grow a backend later; this has one from day one. Server Components also mean the project library queries the database directly, with no API round trip. |
| **TypeScript, `strict` + `noUncheckedIndexedAccess`** | The data model is the backbone. Type errors are how a schema change tells you what it broke. |
| **SQLite + Drizzle ORM** | A personal dashboard is single-user with modest data. SQLite is one file, no service to run, and Drizzle gives typed queries plus real migrations. Deploys to Railway with a volume. |
| **Tailwind CSS v4** | Design tokens live in CSS variables (`globals.css`); Tailwind exposes them as utilities. Retheming is one file. |
| **Zod** | One validation schema shared by forms, API routes and integration payloads. |
| **`lucide-react`** | Consistent, light icon set. |

Total runtime dependencies: ten. Nothing here is load-bearing enough to be hard
to replace.

## 3. Layers

Dependencies point **downward only**. A layer never imports from the one above it.

```
  desktop/      Electron main process and preload bridge (desktop target only).
    ↓
  app/          Routes. Thin — fetch, compose, render.
    ↓
  components/   UI. ui/ primitives, then feature folders.
    ↓
  core/         Domain: types, validation, business logic, integrations.
    ↓
  db/           Persistence: schema, client, repositories.
```

The desktop shell sits above everything and knows nothing about the domain — it
sets two environment variables and manages a window.

### `src/core/` — the domain

Framework-agnostic. No React, no Next.js imports.

- `core/projects/types.ts` — what a Project *is*. Single source of truth.
- `core/projects/schema.ts` — Zod schemas. Validation happens once, at the edge.
- `core/projects/labels.ts` — display metadata for enums. Add a status here and it
  is labelled and coloured everywhere at once.
- `core/github/` — the GitHub integration (see §6).
- `core/activity/` — the activity feed.

### `src/db/` — persistence

- `schema.ts` — Drizzle table definitions (SQLite).
- `schema.pg.ts` — Drizzle table definitions (Postgres, hosted multi-user mode only).
- `client.ts` — one cached SQLite connection per process (WAL, foreign keys on).
- `pg-client.ts` — one cached Postgres pool per process, created lazily.
- `repositories/project-repository.ts` — **the interface**. Every method takes
  a mandatory `workspaceId: string` first argument — explicit, not ambient
  context — plus `LOCAL_WORKSPACE_ID`, the one value SQLite ever accepts.
- `repositories/drizzle-project-repository.ts` — the SQLite implementation.
  Single-tenant forever: it asserts `workspaceId === LOCAL_WORKSPACE_ID` and
  throws otherwise, rather than carrying a `workspace_id` column that would
  never mean anything on desktop.
- `repositories/postgres-project-repository.ts` — the Postgres implementation,
  hosted multi-user mode only. Genuinely scoped: every query — including tags
  and activity events, not just projects themselves — filters on `workspaceId`.
- `repositories/index.ts` — **the composition root**. The only file that names a
  concrete implementation, chosen by whether `DATABASE_URL` is set.

The repository methods are `async` even though better-sqlite3 is synchronous.
That was deliberate from the start: moving to Postgres meant writing one new
class and changing one line in `index.ts` — no caller changes beyond the
`workspaceId` argument itself, which every caller already had to pass once the
interface gained it.

- `core/ownership-claim/service.ts` — the one place that reads both databases
  at once. A pre-accounts-mode hosted install has all its data in SQLite,
  owned by nobody; `claimOwnership(userId, password)` lets exactly one
  signed-in account, proven to be the deployment's operator by also supplying
  its `DASHBOARD_PASSWORD`, import that SQLite `projects`/`tags` data into
  their own personal workspace. The `ownership_claim` table (Postgres) is a
  single row, inserted with `onConflictDoNothing()` before any import
  happens, so a second claim — concurrent or later, by the same account or a
  different one — always loses. SQLite is only ever read, never written.

### `src/config/` — data-driven surfaces

`navigation.ts` and `quick-actions.ts` are plain arrays. Adding a sidebar section
is one entry plus a route file; no component edits.

## 4. Data model

`Project` is the centre of the application. Everything else references it.

```
projects ──┬── project_tags ── tags
           ├── project_files          (Phase 3: uploads)
           ├── activity_events        (the feed)
           ├── notes
           └── github_repositories.linked_project_id
```

### Extensibility, in three tiers

1. **`metadata` (JSON)** — the escape hatch. New fields start here with no
   migration. The GitHub sync uses it for `stars`, `language`, `defaultBranch`
   and so on.
2. **A column** — when a field is queried or filtered often enough to earn one.
3. **A table** — when it has its own lifecycle.

Adding a first-class field is a deliberate three-step change: `core/projects/types.ts`
→ `db/schema.ts` → `core/projects/schema.ts`. TypeScript points at every site that
needs updating.

### Why GitHub repositories are a separate table

`github_repositories` mirrors the **GitHub API**, not the Project model. Syncing
refreshes upstream metadata; your own edits live on the linked `projects` row and
are never overwritten. A repository only becomes a project when you explicitly add
it. This separation is what makes resync safe.

## 5. Component structure

```
components/
  ui/          Primitives — Button, Badge, Card, Field, EmptyState, PageHeader
  layout/      AppShell, Sidebar, CommandPalette, ThemeToggle
  projects/    ProjectCard, ProjectFilters, ProjectForm, actions
  dashboard/   StatTiles, QuickActions, ActivityFeed, ProjectRowList
  github/      RepoList, SyncButton
```

Two rules that keep this from sprawling:

- **One `ProjectCard`.** GitHub, uploaded and manual projects use the same card.
  Source-specific detail (language dot, stars, private lock) renders only when the
  data is there. Same for the detail page — one page, conditional panels.
- **Server Components by default.** `"use client"` appears only where there is
  genuine interactivity: the palette, filters, forms and toggles.

## 6. GitHub integration

The seam is `GitHubProvider` (`core/github/types.ts`):

```ts
interface GitHubProvider {
  readonly mode: "token" | "oauth" | "demo";
  getConnection(): Promise<GitHubConnection>;
  listRepositories(): Promise<GitHubRepository[]>;
}
```

Three implementations, resolved in `core/github/provider.ts`:

1. **`RestGitHubProvider`** — real GitHub REST API, bearer token, pagination.
   Works today with `GITHUB_TOKEN`. In Phase 2 the same class takes an OAuth
   access token instead; nothing else changes.
2. **`DemoGitHubProvider`** — a labelled sample set so the hub is explorable
   before you connect anything. Every screen says it is demo data.

Nothing about GitHub is faked. The real client exists and works; the demo provider
is a clearly-marked fallback behind the same interface.

**Failure handling.** A configured token can be stale, revoked or too narrowly
scoped. `resolveProvider()` probes the connection once and falls back to demo data
on rejection, preserving GitHub's actual error message in `connection.detail`. A
bad token degrades the hub instead of killing it.

## 7. Desktop shell

The desktop build wraps the **same application** — it reimplements nothing.
Server Components query SQLite directly, so the app needs a Node runtime; Electron
starts the Next standalone server on a private localhost port and points a window
at it.

```
Electron main process
  ├─ sets DATABASE_PATH / UPLOADS_DIR → OS user-data directory
  ├─ fork()s .next/standalone/server.js on a free port
  └─ BrowserWindow → http://127.0.0.1:<port>
```

Three decisions carry it:

- **Storage is environment-driven.** `src/db/path.ts` already read `DATABASE_PATH`
  and `UPLOADS_DIR` (they exist so a Railway volume can be used). The desktop build
  sets them to `app.getPath("userData")` before the server starts — zero code
  changes for a completely different storage location.
- **Standalone output is conditional.** `output: "standalone"` is enabled only when
  `DESKTOP_BUILD=1`, because `next start` rejects standalone output. One codebase
  still ships to both Railway and the desktop.
- **asar is disabled.** `fork()` cannot execute a script from inside an asar
  archive, and a native `.node` binary cannot be loaded from one either. Both need
  real files on disk.

### No native rebuild step

Electron and Node use different V8 ABIs, so a native module normally has to be
recompiled at packaging time — which means a full toolchain (Visual Studio Build
Tools on Windows) on every machine that packages the app.

better-sqlite3 v13 ships **Node-API** binaries instead, inside the published
package. Node-API is ABI-stable across both Node versions and Electron versions,
so the same binary file is valid in every runtime this project uses. `npmRebuild`
is therefore set to `false`, and the web and desktop targets share one binary.

The prebuilt binaries cover eight targets: darwin x64/arm64, linux x64/arm64,
linux-musl x64/arm64, and win32 x64/arm64. On those, installing and packaging
genuinely need no compiler. **Anything else falls back to a source build** and
does need a toolchain — node-gyp, Python, and Visual Studio Build Tools on
Windows. That covers, among others, 32-bit Windows, linux armv7 (a Raspberry Pi
before the 64-bit images) and FreeBSD. It is also what happens on a supported
platform if the package is installed with prebuild downloads disabled or from a
partially-written `node_modules`.

better-sqlite3 v13 requires **Node 22 or newer**, which is what `engines.node`
declares. Node 20 satisfied the old `>=20` range and then failed at install.

This is worth preserving. Pinning to a native module that needs `node-gyp` would
reintroduce a toolchain requirement on every developer machine and every CI
runner.

### Security posture

The renderer is a web page and is treated as one: `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`. The preload bridge exposes three narrow
capabilities: menu-driven navigation, project-id-based local actions, and
starting or querying Ollama. None of the three takes a path or a command from
the renderer — a route must look like a route, a local action is an id plus a
fixed action name, and the AI calls take no arguments at all. Verified:
`window.require` and `window.process` are both `undefined` in the renderer.

Outbound links (Open GitHub, Open Project) are intercepted by
`setWindowOpenHandler` and a `will-navigate` guard, and handed to
`shell.openExternal`. They open in the real browser, with your sessions and
extensions — never in a chrome-less Electron window.

### Build-time data isolation

`next build` evaluates the root layout, which opens the database and runs
migrations. Left alone that writes into `./data`, and Next's file tracing would
copy the **developer's real database into the shipped application**.
`desktop/build.mjs` points `DATABASE_PATH` at a temporary directory for the
duration of the build and strips any `data/` directory from the bundle afterwards.

## 7b. Security posture

Two deployments with different threat models share one codebase, and the
middleware is where they diverge.

**Desktop.** The bundled server binds `127.0.0.1` on a random port and is
unreachable from another machine, so `DASHBOARD_LOCAL=1` lets it through
unauthenticated. Asking for a password there would be friction with nothing
behind it.

**Hosted.** A deployment reachable by URL requires `DASHBOARD_PASSWORD`. The
default is fail-safe: production with no password set serves a setup notice
rather than the dashboard, so forgetting cannot silently publish the library.

### Why hosted mode also needs a same-origin check

HTTP Basic credentials are *ambient* — once the browser holds them it attaches
them to requests other sites cause. A form on an attacker's page posting to
`/api/projects` would arrive fully authenticated. A JSON content type would
normally force a preflight and be blocked, but a form with
`enctype="text/plain"` is a simple request that sends no preflight, and
`request.json()` parses a body regardless of its content type — so the JSON API
is reachable that way.

State-changing methods are therefore rejected when the browser reports the
request as cross-site, by `Sec-Fetch-Site` or by an `Origin` that does not match
the host. Only positively cross-site requests are refused: a client sending
neither header is not a browser, so it supplied the password itself and is not
what CSRF describes. Refusing those would break scripts for no security gain.

### Hosted, multi-user (`AUTH_MODE=accounts`)

A third deployment shape: real per-user accounts and workspaces instead of one
shared password. `proxy.ts`'s `handleAccountsMode` branch adds three checks on
top of everything above, each independent and each enforced again below
middleware (never trust `proxy.ts` alone — see this section's own opening):

1. **Session required.** Every page and API call needs a valid Auth.js
   session, except Auth.js's own routes. This is *authentication* only —
   "is someone signed in" — not authorization.
2. **Route allowlist.** Only Dashboard, Projects, Favorites, Settings and the
   invitation-accept page (plus the API routes those need) are reachable at
   all; everything else 404s. This isn't a UI nicety — every other domain
   (AI workspace, uploads, prompts, automations, GitHub sync, notes,
   notifications, integrations, tools) still reads and writes SQLite-only
   tables that were never given a `workspace_id` column, so reaching them
   would show every accounts-mode user the same shared dataset regardless of
   which workspace they're in. `src/app/settings/page.tsx` hides the
   corresponding Settings cards (GitHub connection, Local AI, Storage,
   Application) for the same reason — the GitHub card specifically would
   otherwise expose one shared operator token to every signed-in viewer.
3. **Workspace resolution + role.** `src/core/workspaces/current-workspace.ts`
   resolves the caller's *current* workspace fresh on every request
   (`resolveWorkspaceIdForRequest`/`resolveWorkspaceIdForPage`) — self-healing
   via `ensurePersonalWorkspace` the same way `src/auth.ts`'s
   `events.createUser` does, and only ever returning a workspace the caller
   actually belongs to. That alone proves "may read" (a minimum of the
   `viewer` role); every mutating Projects route additionally calls
   `requireRole(workspaceId, userId, "member")`, re-deriving the role from
   `workspace_member` fresh rather than trusting membership's mere existence.
   `LOCAL_WORKSPACE_ID` and `resolveWorkspaceId`'s `null` return are how the
   same route handlers serve desktop/single-password mode and accounts mode
   without branching on `AUTH_MODE` themselves.

### Renderer isolation

The renderer runs with `contextIsolation` and `sandbox` on and `nodeIntegration`
off. The preload bridge exposes only menu navigation, project-id-based local
actions and the argument-free Ollama calls, and the desktop test asserts both
that surface and that `require`, `process` and `module` are all `undefined` in
the renderer, so widening it fails the suite rather than shipping.

Navigation guards compare parsed origins rather than string prefixes.
`url.startsWith(baseUrl)` admits `http://127.0.0.1:PORT@example.com/`, where
everything before the `@` is credentials, and a bare `route.startsWith("/")`
admits the protocol-relative `//example.com`.

### Token storage

The GitHub token is encrypted at rest in the `settings` table (`src/core/
settings/service.ts`) when the app can protect a key for it, and stored
plaintext — same as always — when it can't (hosted mode, `desktop:dev`, or a
system with no OS keyring).

The obstacle this previously stopped on: the Next server does not run in the
Electron main process. It is `fork()`ed with `ELECTRON_RUN_AS_NODE=1`, so it
is plain Node — `require("electron")` there yields a path, not the API — and
only the main process can call `safeStorage`. The straightforward design,
round-tripping every encrypt/decrypt over the existing `fork()` IPC channel to
the main process, forces `getSetting`/`setSetting` to become async, which
ripples into provider resolution, the device flow and the updates service, all
of which call them synchronously today.

**Envelope encryption avoids that ripple.** `safeStorage` is used exactly
twice, both already in the main process, both at app startup, in
`desktop/main.js`'s `resolveEncryptionKey()` — never per setting operation. It
protects one small symmetric key (`<userData>/settings-key.enc`), stable
across restarts, which then travels to the forked server once as an env var,
`SETTINGS_ENCRYPTION_KEY`, the same way `DATABASE_PATH` already does. The
server does the actual AES-256-GCM encrypt/decrypt of setting values itself
with Node's built-in `crypto` — synchronous, so `getSetting`/`setSetting`
never change shape.

Values carry an `enc:v1:` prefix when encrypted, so plaintext (no key
available) and encrypted rows coexist. A pre-existing plaintext value is
upgraded the first time it's read after a key becomes available — no user
action, no separate migration step. Scope is narrow: only
`SETTING_KEYS.githubToken` is treated as a secret; `githubClientId` isn't one,
and `githubTokenOrigin` is just `"oauth" | "pat"`.

## 7c. A hydration bug worth remembering

`/settings` intermittently failed hydration (React #418) in roughly forty
percent of visits. The cause was not in the component that appeared to be at
fault, and the first two explanations were wrong, so the shape of it is worth
recording.

**The cause.** The root layout is a server component and imported `themeScript`
— a plain string — from `theme-toggle.tsx`, which carries `"use client"`.
Importing a value out of a client module pulls that module into the server graph
as well, and the same module was *also* rendered as a client component in two
different segments: the layout's sidebar and the Settings page's Appearance
card. `/settings` was the only route that did both, and the only route that
failed. Moving `themeScript` and `STORAGE_KEY` into their own plain module fixed
it: 0 failures in 50 attempts, against 17 in 40 before.

**Two wrong answers first.** It correlated with the automation scheduler's first
tick, which was a coincidence of sample size — measured properly, the failure
rate is the same with the scheduler off. It then looked like the component's own
`useSyncExternalStore` mount gate, but replacing that with an effect, and
removing the `localStorage` read from the initial render, changed nothing. What
settled it was deleting the component from the page (0/40) and then rendering an
identical copy from a *separate module* (0/20) — same code, no failure, which
pointed at the module rather than the logic.

**Why the tests missed it.** Two conditions are needed and neither is what a
test does by default. `<Link>` prefetching is production-only, so the route has
to be reached from a page that links to it rather than loaded directly. And it
only appears on a cold cache, so a suite reusing one browser page never sees it.
`tests/e2e/helpers.ts` gained `withFreshPage` for exactly this, and the route
suite now walks every route from another page in a fresh context, several times
each, because a single clean pass proves nothing against a forty-percent
failure.

The general rule: **do not import values out of `"use client"` modules from
server components.** Put shared constants and strings in a plain module that
both can import.

## 8. State and URLs

Filter state lives in the **URL**, not React state. A filtered library view is
shareable, bookmarkable and survives a refresh, and the Server Component re-queries
on every change. `ProjectFilters` writes search params; `buildQuery()` in
`app/projects/page.tsx` translates them into a repository query, and every listing
page reuses it so filters behave identically everywhere.

## 9. Phases

**Phase 1 — Foundation (shipped).** Shell, sidebar, dashboard, unified library,
project cards, detail page, search, filtering, manual CRUD, favorites, archive,
tags, activity feed, command palette, dark/light themes, GitHub hub with a real
client and demo fallback.

**Phase 2 — GitHub OAuth (shipped).** Connecting an account uses GitHub's device
flow rather than the authorization-code flow. The redirect flow does not fit a
desktop application: it needs a registered callback URL, but the bundled server
listens on a different random port each launch, and it needs a client secret,
which in a distributed installer is not secret. The device flow needs neither —
only a public client id — and it grants classic scopes, avoiding the
fine-grained repository/permission configuration that is easy to get wrong.

No new provider was required. The token it returns is stored under the same
settings key a pasted token uses, so `resolveGitHubProvider` was unchanged apart
from recording which route produced the credential.

**Phase 3 — Uploads (shipped).** A `StorageDriver` interface behind a local-disk
implementation, upload and download routes, a file panel on the project detail
page, and an upload-first flow for projects that do not live on GitHub. Uploaded
filenames are display data only — files on disk are named by generated id, so a
filename can never become a path.

**Phase 4 — AI (shipped).** A prompt library with full CRUD, search across
titles *and* bodies, categories and favourites; and an AI workspace collecting
prompts, AI-typed projects and one-click links to the tools you actually use.

Workflows deliberately stayed scaffolded. A workflow that cannot be executed is
only a list, and what executes it — a scheduler, run history, somewhere for
results to land — is Phase 5. Building the UI first would have produced
something that looked finished and did nothing.

**Phase 5 — Automation (shipped).** A task catalogue in code, schedules in the
database, an in-process scheduler, and a notification inbox.

The scheduling model is shaped by what a desktop app actually is. There is no
always-on server, so this is not cron: the scheduler ticks while the app is open,
and because due-ness is computed from `lastRunAt` rather than a live timer,
anything that fell due while the app was closed runs shortly after it reopens.
That is the honest behaviour for a dashboard you open regularly, and the
Automations page says so rather than implying background execution.

Adding an automation is one entry in `core/automation/tasks.ts` — the scheduler,
the settings UI and the run history all read from that list. Rows are created on
read rather than by migration, so a task added in a later version needs no
schema change.

**Phase 6 — Local AI (shipped).** Ollama running on the user's own machine,
reached through a provider interface rather than by scattering `fetch` calls
through components.

**Hosted accounts & workspaces (shipped, a separate track from Phases 1–6
above — see its own "SaaS Phase 1" plan, not renumbered here to avoid
confusion with the phases already named Phase 1–6).** Real per-user sign-in
and team workspaces (`AUTH_MODE=accounts`) on top of the same codebase,
genuinely scoping only the Projects domain for now; every other domain above
stays desktop/single-password-only in this mode rather than exposed
half-scoped (§2b/§7/§11 in docs/OVERVIEW.md, §7b below). Ends at one working
flow: sign in → create workspace → create project → invite teammate →
role permissions enforced. Full tenant isolation of the other domains named
in Phases 1–6 is a later phase's work, not this one's.

**Command Center Phase 2, Release A — Milestones, tasks & dependencies
(shipped, its own "Release A" plan — see `core/tasks/`).** The first
planning/execution domain beyond `projects` itself: milestones and tasks
per project, subtasking (one level deep in the UI, though the schema
allows more), dependencies between tasks with cycle prevention (a
recursive CTE, checked inside a transaction; Postgres also row-locks
against a concurrent add forming the same cycle), and a `blocked` status
computed at read time from the dependency graph rather than stored. Genuinely
workspace-scoped in accounts mode from the start — `PostgresMilestoneRepository`/
`PostgresTaskRepository` mirror `PostgresProjectRepository`'s own pattern
exactly, so this domain needed no separate "port it later" step the way
Phases 1–6 above did. My Work (`/my-work`) is the cross-project view: every
task in the caller's current workspace, filtered to their own `assigneeId`
in accounts mode, every task in the one workspace on desktop (no user
concept there). Ends at one working flow: break a project into milestones
and tasks → mark a dependency → the dependent task shows blocked → complete
the blocker → it unblocks → complete the milestone → My Work reflects it,
including across a workspace switch.

Deliberately deferred (this release's own explicit scope cut, not an
oversight): recurring tasks, checklists, reusable templates, calendar/
timeline views, bulk editing; an assignee picker/display (needs a
members-list endpoint that returns names, not just `userId`+role — see
`core/workspaces/service.ts`'s `listMembers()`); and everything the wider
Phase 2 brief named that needs infrastructure this release didn't build —
a GitHub issues/PRs/releases client, deployment/uptime monitoring, a
durable hosted job system, and AI-generated summaries with a review/
approval workflow. Each is a later release's work.

**Command Center Phase 2, Release B — Project knowledge base (shipped, its
own "Release B" plan — see `core/knowledge/`).** A flat, per-project list
of plain-text documents (title, content, optional free-text category, a
`pinned` flag) — the next Phase 2 slice after Release A, picked as a
self-contained release that reuses the exact same repository/API/UI
pattern with no new infrastructure. `KnowledgeDocumentRepository` mirrors
`MilestoneRepository`'s own shape exactly (mandatory `workspaceId` first
arg, a Drizzle implementation guarded by `assertLocalWorkspace()`, a
genuinely workspace-scoped Postgres implementation); search across
title/content/category follows `core/prompts/service.ts`'s own search
reasoning (the content is the point, so it's covered too, not just the
title). Unlike Release A, this release needed **no `proxy.ts` or
`config/navigation.ts` changes**: every route is nested under a project
(`/projects/:id/knowledge`, `/api/projects/:id/knowledge`), so the
existing `/projects`/`/api/projects` prefix allowlist entries already
cover it, and the feature is reached from the project detail page rather
than the sidebar — same as `/projects/:id/tasks`. Ends at one working
flow: create a document → edit it → search/filter by category → pin it →
the project overview card reflects it.

Deliberately deferred, this release's own explicit scope cut: folders/
hierarchy, markdown rendering, version history, workspace-wide (cross-
project) search, attachments (the existing `uploads`/`files` domain is
SQLite-only and unscoped in accounts mode, same limitation as several
domains named in Release A's own plan), and any linking between documents
and tasks/milestones. Each is later work, not an oversight.

### Where the work happens

The desktop build is not a wrapper around a static page: it forks a real Next
server (§7). That server is an ordinary Node process on the user's machine, so
**all Ollama HTTP lives server-side** — `core/ai/` plus route handlers under
`app/api/ai/` — and only *process launching* needs the Electron main process.
The alternative, proxying every model call over IPC, would have doubled the
surface of `preload.js` for no gain.

```
core/ai/types.ts          the vocabulary: states, errors, AIProvider
core/ai/ndjson.ts         incremental NDJSON (Ollama streams one object a line)
core/ai/ollama-client.ts  the HTTP boundary; fetch is injectable
core/ai/local-provider.ts Ollama as an AIProvider
core/ai/hermes-provider.ts   the agent seam — detects Hermes, runs nothing
core/ai/approvals.ts      the action vocabulary *and* the approval decision
core/ai/attachments.ts    resolving picked project files into prompt text
core/ai/service.ts        which provider answers, and whether local AI applies
core/ai/settings.ts       preferences on the existing key/value store
core/ai/conversations.ts  transcripts, on the existing database
desktop/ollama.js         process lifecycle, no Electron import, testable
```

### Ollama lifecycle

`desktop/ollama.js` holds the whole contract, and the shell calls it once the
bundled server is up (so the user's saved preferences can be read from the
database rather than duplicated into the shell):

1. **Probe first.** `GET /api/tags` decides whether anything is serving. Not a
   TCP connect — something else could hold the port, and "the port is open" is
   not "Ollama will answer".
2. **Adopt, never duplicate.** A healthy instance is used as-is and marked *not
   owned*.
3. **Otherwise launch**, trying a fixed list of locations per platform with an
   argv array and `shell: false`. ENOENT arrives as an asynchronous `error`
   event, so a launch is only counted as ours once the API answers *and* the
   child has not died.
4. **Lose the race gracefully.** If our launch fails but the endpoint is healthy
   a moment later — the tray app started at the same time — that is `adopted`,
   not `started`, and not owned.
5. **On quit, stop only what we started.** An Ollama that was already running
   when Command Center opened is left exactly as it was found. This is why
   ownership is tracked explicitly rather than inferred.

Starting the *service* is cheap; loading a *model* is not. Nothing is pulled
into VRAM at launch unless "Preload the default model" is on, so the ordinary
path is: app starts → API healthy → **Ready** → first message loads the model.
Unloading is Ollama's own `keep_alive`, derived from the idle-timeout setting,
rather than a competing timer of ours.

### Chat and Agent

Two modes, two providers, one interface. Chat mode is Ollama and has no tools at
all — that is the guarantee, not a policy. Agent mode is the Hermes seam: it
detects the executable (by `stat`, never by running it, since the path is a
user-writable setting and settings are writable through the HTTP API) and
refuses to generate rather than faking agency with the chat model.

`core/ai/approvals.ts` defines the action vocabulary *and* the decision.
`evaluateAction` is the single function a would-be agent action goes through, so
"what is allowed" has one answer that can be tested rather than a rule restated
at each call site. Defaults are the strict end — read is automatic, writes and
commands ask, push is blocked — and overrides live one row per action in the
settings table (`ai.approval.run_command`), for the same reason the AI
preferences do: a single JSON blob cannot be changed one field at a time without
a read-modify-write race.

Launching Hermes is itself running a command, so `run_command` is what gates the
provider. The policy is consulted **before** the filesystem: with it blocked,
`status()` reports the provider off and `chat()` refuses with the policy's own
reason, without looking for the executable. That ordering is the point — an
agent refused only at the moment of acting has already decided to act — and it
means the execution, when it lands, is written against a policy that already
exists rather than one retrofitted around whatever the execution turned out to
do.

### Project context

Metadata only: name, kind, status, tags, path, repository and the checked-out
branch, read from `.git/HEAD` rather than by spawning git (no PATH dependency,
no process per render, no user-supplied directory next to a command line).
Repository *contents* are never sent because a project is selected.

The system prompt has always ended by telling the model to ask the user to
attach specific files, and `core/ai/attachments.ts` is that mechanism. It keeps
the property the prompt describes: files are sent because the user picked them
for one message, never as a side effect of opening a page. Three limits, each
protecting something different — a count so the picker stays honest, a per-file
cap so one large file cannot consume the context window, and a total so a single
request is bounded. Bytes containing NUL are refused rather than pasted in, the
same test `git` uses.

The load-bearing check is the project scope: ids arrive from the browser, so
every file is verified to belong to the project the conversation is pointed at.
Without it, a chat about one project could read every other project's uploads by
naming their ids. Attachments are also resolved *before* the turn is written, so
the transcript records what was actually sent rather than what was asked for, and
what it records is a summary — id, name, size, whether it was truncated — not the
bytes, which stay in the uploads directory where they can be re-read or deleted.
File contents reach the model inside delimiters and under an instruction to treat
them as material to read rather than instructions to follow: an uploaded file is
untrusted text, and arriving in a system message should not make it more
persuasive than the person typing.

### Hosted mode

A Railway deployment shares no machine with Ollama, so `detectRuntime()` reports
`hosted` and the workspace says the feature needs the desktop app. Without that,
the hosted copy would ask its own container about models and show a permanent
"connecting…".

## 10. Adding things — quick reference

| To add… | Do this |
| --- | --- |
| A sidebar section | One entry in `config/navigation.ts` + a route file |
| An AI provider | Implement `AIProvider` in `core/ai/`, return it from `getProvider()` |
| A local AI preference | `core/ai/config.ts` → a key in `core/settings/service.ts` → `core/ai/settings.ts` |
| A project field | `core/projects/types.ts` → `db/schema.ts` → `core/projects/schema.ts` → `npm run db:generate` |
| An experimental field | Put it in `metadata`; no migration |
| A project status or type | Add to the const array in `types.ts` + an entry in `labels.ts` |
| A quick action | One entry in `config/quick-actions.ts` |
| A scheduled automation | One entry in `core/automation/tasks.ts`; the row is created on read |
| An integration | Define a provider interface in `core/<name>/`, resolve it in one place |
| A different database | New `ProjectRepository` implementation + one branch in `db/repositories/index.ts` |

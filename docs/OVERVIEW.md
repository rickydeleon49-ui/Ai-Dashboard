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

It is **single-user by design**. There are no accounts, no tenancy and no
sharing model; access control is one password on hosted deployments and nothing
at all on the desktop, because the desktop server is unreachable from off the
machine.

One codebase ships to two targets:

| Target | What it is | Storage | Auth |
| --- | --- | --- | --- |
| **Desktop** (primary) | Electron window wrapping the bundled Next.js server on `127.0.0.1:<random>` | OS user-data directory | none — not network reachable |
| **Web** (optional) | The same app served by `next start`, e.g. on Railway | `./data`, or a mounted volume | HTTP Basic via `DASHBOARD_PASSWORD` |

Roughly 11.6k lines of TypeScript/JavaScript across `src/` and `desktop/`, with
nine runtime dependencies.

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
    dashboard/        StatTiles, QuickActions, ActivityFeed, ProjectRowList
    prompts/ github/ automation/ settings/
  core/
    projects/         types · schema (Zod) · labels · query
    github/           provider interface · REST · demo · device flow · service
    automation/       tasks · scheduler · service · notifications
    files/ storage/   upload service + StorageDriver (local-disk implementation)
    prompts/ activity/ settings/ updates/
  db/
    schema.ts         Drizzle tables
    client.ts         one cached connection per process
    repositories/     interface · Drizzle implementation · composition root
  config/             navigation.ts, quick-actions.ts, app.ts — surfaces as data
  middleware.ts       auth + CSRF for the whole app
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
           └── github_repositories.linked_project_id

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

Migrations live in `drizzle/` and are generated with `npm run db:generate`. They
also run automatically on first request (`src/db/bootstrap.ts`), so a fresh
clone or a fresh Railway volume works with no manual step.

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
password itself.

**Renderer isolation.** `contextIsolation: true`, `sandbox: true`,
`nodeIntegration: false`. The preload bridge exposes a minimal surface, outbound
links are intercepted and handed to `shell.openExternal`, and navigation guards
compare parsed origins rather than string prefixes. The desktop test asserts
that `require`, `process` and `module` are all `undefined` in the renderer, so a
regression fails the suite rather than shipping.

**Upload safety.** Uploaded filenames are display data only; files on disk are
named by generated id, so a filename can never become a path.

**Known gap.** The GitHub token is stored as plaintext in the `settings` table.
It sits in the OS user-data directory with user-only permissions and is a scoped
credential rather than a password, but it is not encrypted at rest. Electron's
`safeStorage` is the right answer and is not a small change — the Next server is
`fork()`ed as plain Node, so encryption would need an IPC protocol, a hosted
fallback and a migration path. ARCHITECTURE.md §7b has the full analysis.

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

**CI**: `.github/workflows/desktop.yml` builds installers on hosted runners —
manually from the Actions tab, or for every `v*` tag. Installers cannot be
cross-built, so each platform runs on its own runner, and macOS is arm64 only
because better-sqlite3 downloads a prebuilt binary for the *building* machine.

---

## 10. Configuration

All optional — see `.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_PATH` | `./data/dashboard.db` | SQLite file location |
| `UPLOADS_DIR` | `./data/uploads` | Uploaded files |
| `GITHUB_TOKEN` | — | Personal access token for live repository data |
| `GITHUB_CLIENT_ID` | — | OAuth app client id, enabling the device flow |
| `DASHBOARD_PASSWORD` | — | **Required** for any hosted deployment |
| `DASHBOARD_LOCAL` | — | `1` bypasses auth; set by the desktop shell only |
| `DASHBOARD_DISABLE_SCHEDULER` | — | `1` turns automations off (used by tests) |
| `DESKTOP_BUILD` | — | `1` switches Next to standalone output |

Desktop data lives in the standard per-user directory
(`~/Library/Application Support/Command Center/data`,
`%APPDATA%\Command Center\data`, `~/.config/Command Center/data`), reachable
from **File → Open Data Folder**. Back up that folder and you have backed up
everything.

---

## 11. Rough edges

Honest inventory of what is not finished:

- **`/uploads` is linked but has no route.** The sidebar, the dashboard, quick
  actions and the Integrations page all point at `/uploads`, and no page file
  exists under `src/app/uploads/` — the link resolves to the not-found page.
  `tests/e2e/routes.test.ts` asserts a 200 for it, so the end-to-end suite should
  be failing on that route. Uploading itself works: the API, the storage driver
  and the project file panel are all in place; only the listing page is missing.
- **Workflows are automations.** `/ai/workflows` is the automations screen; there
  is no user-defined workflow builder, and the task catalogue is code, not data.
- **`/notes` and `/tools` exist but are unadvertised.** They are placeholder
  pages, intentionally removed from the sidebar rather than deleted.
- **The GitHub token is not encrypted at rest** (§7).
- **Updates are checked, not installed** — the repository is private, and
  auto-update would mean shipping a token inside the installer.

---

## 12. Where to add things

| To add… | Do this |
| --- | --- |
| A sidebar section | One entry in `config/navigation.ts` + a route file |
| A quick action | One entry in `config/quick-actions.ts` |
| A project field | `core/projects/types.ts` → `db/schema.ts` → `core/projects/schema.ts` → `npm run db:generate` |
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

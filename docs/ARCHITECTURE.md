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

Total runtime dependencies: nine. Nothing here is load-bearing enough to be hard
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

- `schema.ts` — Drizzle table definitions.
- `client.ts` — one cached SQLite connection per process (WAL, foreign keys on).
- `repositories/project-repository.ts` — **the interface**.
- `repositories/drizzle-project-repository.ts` — the SQLite implementation.
- `repositories/index.ts` — **the composition root**. The only file that names a
  concrete implementation.

The repository methods are `async` even though better-sqlite3 is synchronous.
That is deliberate: moving to Postgres, Turso or a hosted API means writing one
new class and changing one line in `index.ts` — no caller changes.

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

better-sqlite3 v13 ships **Node-API** binaries instead, one per platform, inside
the published package. Node-API is ABI-stable across both Node versions and
Electron versions, so the same binary file is valid in every runtime this project
uses. `npmRebuild` is therefore set to `false`: there is nothing to rebuild,
packaging needs no compiler, and the web and desktop targets share one binary.

This is worth preserving. Pinning to a native module that needs `node-gyp` would
reintroduce a toolchain requirement on every developer machine and every CI
runner.

### Security posture

The renderer is a web page and is treated as one: `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`. The preload bridge exposes exactly one
capability — letting the application menu drive client-side navigation — and the
route it accepts must start with `/`. Verified: `window.require` and
`window.process` are both `undefined` in the renderer.

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

**Phase 2 — GitHub OAuth.** Add `OAuthGitHubProvider`, the callback route and token
storage in `settings`. The hub UI does not change.

**Phase 3 — Uploads.** `project_files` and the uploads directory resolver exist.
Add a storage driver interface (local disk first), the upload route, ZIP handling
and the file panel on the detail page.

**Phase 4 — AI.** `prompts` is migrated. Build the workspace, prompt library and
workflows on the same repository pattern.

**Phase 5 — Automation.** Scheduled workflows, monitoring, notifications.

## 10. Adding things — quick reference

| To add… | Do this |
| --- | --- |
| A sidebar section | One entry in `config/navigation.ts` + a route file |
| A project field | `core/projects/types.ts` → `db/schema.ts` → `core/projects/schema.ts` → `npm run db:generate` |
| An experimental field | Put it in `metadata`; no migration |
| A project status or type | Add to the const array in `types.ts` + an entry in `labels.ts` |
| A quick action | One entry in `config/quick-actions.ts` |
| An integration | Define a provider interface in `core/<name>/`, resolve it in one place |
| A different database | New `ProjectRepository` implementation + one line in `db/repositories/index.ts` |

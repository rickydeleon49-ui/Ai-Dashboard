# Command Center

A personal project operating system — one place to see, organise, launch and
manage everything you work on: GitHub repositories, uploaded projects, manual
projects, and eventually AI workflows.

**Runs as a desktop application** (macOS, Windows, Linux) and as a web app from
the same codebase.

Built to be extended for years, not to be a throwaway dashboard.

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

## What is here now (Phase 1)

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
- **Favorites**, **tags**, **notes**, **activity tracking**
- **Command palette** — `⌘K` / `Ctrl+K` over projects, actions and pages
- **Dark, light and system themes**, responsive from phone to wide desktop

Sections for Uploads, AI, Prompts, Workflows, Tools and Notes exist as routes with
their database tables already migrated. They say plainly what is coming and what is
already in place underneath rather than showing fake screens.

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

## Architecture

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the layer model, the data
model, the GitHub provider seam, the phase plan, and a quick reference for adding
new sections, fields and integrations.

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

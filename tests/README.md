# Tests

```bash
npm test          # unit, then end-to-end
npm run test:unit # fast; no build, no browser
npm run test:e2e  # builds, boots a real server, drives Chromium
```

## What runs where

**Unit** (`tests/unit`) covers logic that is cheap to isolate: project queries,
archive and restore, file storage safety and batch behaviour, GitHub sync
cleanup, and schema validation. Each file gets its own throwaway SQLite database
via `tests/helpers/db.ts`, which sets `DATABASE_PATH` and `UPLOADS_DIR` before
anything imports the client — the client opens its connection at import time, so
the application modules are loaded inside `before()` rather than at the top of
the file.

**End-to-end** (`tests/e2e`) builds the app, starts a real production server on a
throwaway database and drives it with Chromium: every navigation destination,
project create/edit/archive/restore/delete, uploads, the GitHub fallback, and
prompt CRUD.

**Desktop** (`tests/e2e/desktop.test.ts`) launches the real Electron main
process against the real bundled server and checks the window renders, the
renderer has no `require`/`process`/`module`, and the preload bridge exposes
exactly three keys. It needs a standalone build and a display:

```bash
npm run desktop:build
xvfb-run -a npm run test:desktop   # or just `npm run test:desktop` with a display
```

It skips itself when `.next/standalone/server.js` is absent, so the ordinary
suite does not require a desktop build first. It sets `DESKTOP_BUNDLED=1`,
because `app.isPackaged` is false for anything run from a checkout — without it
the shell would take the development path, wait for a `next dev` that is not
running, and then block on an error dialog.

## Cold-cache and cross-page failures

`withFreshPage` runs a check in a new browser context. Some failures only appear
on a first visit with an empty cache, and only when a route is reached from
another page rather than loaded directly — `<Link>` prefetching is
production-only. A hydration bug on `/settings` that reproduced about forty
percent of the time was invisible to the ordinary route checks for both reasons.
Anything sensitive to a first visit belongs in `withFreshPage`, repeated several
times: one clean pass proves nothing against an intermittent failure.

## Two things worth knowing

**No test runner was added.** These use Node's built-in `node:test` with the
`playwright` library that was already a dependency, so the suite costs no new
packages. `--conditions=react-server` resolves the `server-only` marker package
to its empty build; without it, importing anything under `src/core` throws.

**Postgres-backed tests split across two directories.** `tests/unit-pg/`
(`npm run test:unit:pg`) runs with `--conditions=react-server`, same as
`tests/unit/`, because it exercises `src/core/*` service code guarded by
`server-only`. `tests/unit-pg-auth/` (`npm run test:unit:pg:auth`) is the one
exception: Auth.js's import graph reaches Next's client-side navigation
internals, which need the real React build, not the server-only one that flag
selects — so that suite runs without it instead. Put a new Postgres-backed
test in `unit-pg-auth/` only if it touches Auth.js directly; everything else
goes in `unit-pg/`. Since `src/auth.ts` also imports workspace service code
guarded by `server-only`, `test:unit:pg:auth` preloads
`tests/helpers/stub-server-only.cjs` via `NODE_OPTIONS` to neutralize that
guard without turning the flag back on.

**`next start` is run directly, not through `npx`.** `npx` spawns the server as
its own child, so killing the returned handle left it running — and a leaked
server keeps serving an older build, then answers the next run and produces
failures that look like application bugs. It is spawned `detached` and stopped by
signalling the process group.

If the machine's Chromium does not match the Playwright package, point at it:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium npm run test:e2e
```

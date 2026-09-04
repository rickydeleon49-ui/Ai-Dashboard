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

## Two things worth knowing

**No test runner was added.** These use Node's built-in `node:test` with the
`playwright` library that was already a dependency, so the suite costs no new
packages. `--conditions=react-server` resolves the `server-only` marker package
to its empty build; without it, importing anything under `src/core` throws.

**`next start` is run directly, not through `npx`.** `npx` spawns the server as
its own child, so killing the returned handle left it running — and a leaked
server keeps serving an older build, then answers the next run and produces
failures that look like application bugs. It is spawned `detached` and stopped by
signalling the process group.

If the machine's Chromium does not match the Playwright package, point at it:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium npm run test:e2e
```

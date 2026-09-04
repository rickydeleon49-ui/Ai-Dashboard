# Handoff — Command Center

Context for whoever picks this up next. Written at commit `64625be`.

---

## Where this stands

**The application is built, packaged and installed.** Phase 1 is complete, and it
runs as both a desktop app and a web app from one codebase.

| | Status |
| --- | --- |
| Phase 1 web app | Done. Typecheck, lint and production build clean. |
| Electron desktop shell | Done. Verified by running the real packaged app. |
| Linux AppImage | Built and run successfully. |
| Windows `.exe` | **Done.** Built locally and in CI, installed, running at 0.2.0 with live GitHub sync against a real token. |
| macOS `.dmg` | Not attempted. User does not have the machine yet. |

---

## Reproducing the Windows build

Confirmed working on the user's machine (Ryzen desktop, Git Bash, Node 24):

```bash
cd ~/code/Ai-Dashboard
git pull
npm run desktop:package
```

Result: `release/Command Center-0.1.0-win-x64.exe`, which installs
per-user (no admin prompt) and creates a desktop shortcut plus Start Menu entry
named **Command Center**.

To launch it from Git Bash, the filename contains a space, so use a glob:

```bash
./release/*.exe
```

### Alternative build path

If a local build ever regresses, use CI instead of iterating on the user's machine — `.github/workflows/desktop.yml` builds installers
on hosted runners for Windows, macOS and Linux:

- Actions tab → **Desktop build** → Run workflow → pick `windows`
- Download the `.exe` from the run's artifacts

The assistant's session token could not dispatch workflows (403, `actions: write`
not granted) or push tags, so the user must click Run. That is a one-click action
and gets a real Windows build with no local toolchain involved.

---

## Bugs already found and fixed — do not reintroduce these

Each of these cost a round trip. They are all committed; this list exists so the
reasoning is not lost.

1. **`npx` masking a missing install** (`3db0012`)
   The build scripts called `npx next build`. With no `node_modules`, npx silently
   runs some *other* copy of Next, which then dies deep in Turbopack with
   "Could not find the Next.js package" and five speculative causes. The scripts
   now resolve binaries from the project via `createRequire` and fail with one
   clear sentence. They also run through `process.execPath` instead of
   `shell: true`, which removes the DEP0190 warning and platform quoting
   differences.

2. **`desktopName` in the wrong place** (`92c1fb3`)
   Put under `build.linux`, where electron-builder's schema has no such option.
   electron-builder validates *every* platform's config regardless of the target
   being built, so a Linux-only mistake broke Windows packaging. It belongs at the
   package.json root with `linux.syncDesktopName` alongside.

3. **Symlinks in the packaged app** (`913ad36`)
   Next emits the standalone bundle with a symlink per external server package
   (`better-sqlite3`), pointing at the real copy inside the same bundle. Windows
   lets Next *create* it, but electron-builder re-creates every symlink while
   copying — and creating a symlink on Windows requires Administrator rights or
   Developer Mode. `desktop/build.mjs` now materialises symlinks into real files.

4. **Root `node_modules` being packaged** (`913ad36`)
   Shipped alongside the standalone bundle's own pruned copy, so electron-builder
   deduplicated the overlap with *more* symlinks. Nothing needed it: the main
   process requires only `electron`, and the forked server resolves from the
   bundle. Excluding it removed the duplication and cut the app from 244MB to
   146MB.

5. **PNG passed to NSIS as an icon** (`64625be`)
   `nsis.installerIcon` / `nsis.uninstallerIcon` go straight to `makensis`, which
   does no conversion and rejects anything that is not a classic icon file.
   A PNG-based `.ico` fails too — NSIS rejects PNG-compressed entries. The
   generator now emits a multi-size `.ico` (16–256) with classic BMP/DIB entries.
   Verified against the same `makensis` binary electron-builder uses, with the old
   PNG as a failing control.

### Do not import values out of `"use client"` modules from server components

The root layout imported `themeScript`, a plain string, from the client module
that also defines `ThemeToggle`. That put one module in both graphs while it was
rendered as a client component in two segments, and `/settings` — the only route
doing both — failed hydration about forty percent of the time. Shared constants
belong in a plain module both sides import. Written up in full in
`docs/ARCHITECTURE.md` §7c, including the two explanations that were wrong first.

### Environment problems that were not code

- The user's first attempt ran in `C:\Program Files\Git` (Git Bash's `/` is the
  Git install root). The clone failed on permissions, `cd` then failed, and
  `npm install` ran in a protected directory. The half-written tree it left
  behind is what later made npm try to compile `better-sqlite3` from source and
  fail for lack of Visual Studio. better-sqlite3 v13 ships Node-API binaries for
  darwin, linux, linux-musl and win32 on x64 and arm64, so **on those platforms
  a clean `npm install` needs no compiler**. A target outside that list genuinely
  does build from source and genuinely does need a toolchain. On a supported
  platform, then, an attempted native build means something is wrong with the
  tree rather than with the configuration. The recovery was:
  ```bash
  npm cache clean --force
  rm -rf node_modules package-lock.json
  npm install
  ```
  Restore the lockfile afterwards with `git checkout -- package-lock.json`.
  Deleting it is what makes the recovery work, but `npm install` then writes a
  fresh one that differs from the committed file, and a permanently dirty
  lockfile blocks every later `git pull` (see below).

- **`git pull` aborting on `package-lock.json`.** The message is "Your local
  changes to the following files would be overwritten by merge", and the file is
  always `package-lock.json`. It is a generated file and the local version is
  never worth keeping, so discard it and pull:
  ```bash
  git checkout -- package-lock.json
  git pull
  ```
  The lock already carries every platform's optional dependencies (win32, darwin
  and linux binaries for swc, esbuild, sharp, oxide and lightningcss), so
  installing on Windows does not legitimately need to rewrite it. If it comes
  back dirty after a plain `npm install`, the npm major version differs from the
  one that generated it — commit the rewrite once rather than discarding it
  every time.

- **A fine-grained GitHub PAT grants nothing by default.** Repository access and
  permissions are both opt-in, and a token with neither still authenticates — so
  the hub reported "Connected as @user" while listing a single repository, and
  `git pull` failed with "Write access to repository not granted". Neither
  message points at the real cause. A working token needs **All repositories**
  (or the specific repo) plus **Contents: Read** and **Metadata: Read**;
  permissions can be edited on an existing token without regenerating it. A
  classic token with the `repo` scope avoids the whole distinction.

- Five `npm audit` vulnerabilities are all in dev-only tooling (the deprecated
  `glob`/`inflight`/`rimraf` chain under electron-builder and eslint). Nothing
  ships in the app. **Do not run `npm audit fix --force`** — it bumps majors and
  will break the build for no security benefit.

---

## Architecture, briefly

Full detail is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The short version:

```
desktop/      Electron main process, preload bridge, build scripts
app/          Routes — thin
components/   ui/ primitives, then feature folders
core/         Domain: types, validation, logic, integrations (no framework)
db/           Schema, client, repositories behind an interface
config/       Navigation and quick actions as data
```

Dependencies point downward only. Two seams carry the extensibility:

- **`ProjectRepository`** is an interface; the Drizzle implementation is named in
  exactly one file (`src/db/repositories/index.ts`). Swapping SQLite for Postgres
  is one new class and one changed line. Methods are `async` despite
  better-sqlite3 being synchronous, precisely so that swap needs no caller
  changes.
- **`GitHubProvider`** is an interface with a real REST implementation (bearer
  token today, OAuth in Phase 2 with no UI change) and a clearly-labelled demo
  provider used when no credentials are configured. A rejected token degrades to
  demo data with GitHub's own error preserved.

### Things that look odd but are deliberate

- **`output: "standalone"` is conditional** on `DESKTOP_BUILD=1`. `next start`
  rejects standalone output, so the web target would break if it were always on.
- **asar is disabled.** `fork()` cannot execute a script from inside an asar
  archive, and a native `.node` binary cannot be loaded from one.
- **`npmRebuild: false`.** better-sqlite3 v13 ships Node-API binaries, which are
  ABI-stable across Node *and* Electron versions. There is nothing to rebuild, and
  turning this on would reintroduce a compiler requirement on every machine.
- **`desktop/build.mjs` points `DATABASE_PATH` at a temp directory during the
  build.** Next evaluates the root layout while collecting page data, which opens
  the database and runs migrations. Without this, Next's file tracing copies the
  *developer's real database* into the shipped application.

---

## Verification standard

The failures above happened because changes were verified on Linux and assumed to
hold on Windows. Two habits fixed that, and are worth keeping:

- **Re-run packaging after any change to `build` config in package.json.**
  Bug 2 shipped because a config key was added after the last packaging run.
- **Reproduce before fixing.** With `npmRebuild: false`, electron-builder
  cross-builds far enough on Linux to reproduce Windows NSIS failures. It stops at
  `wine ENOENT` (needed to run `signtool.exe`), which is *after* the interesting
  parts. That is how bug 5 was caught and proven.

The packaged app can be run headlessly for real verification:

```bash
cd release && ./"Command Center-0.1.0-linux-x86_64.AppImage" --appimage-extract
# asar is off, so desktop/main.js in the extracted app can be edited to add a
# capturePage() hook, then run under:
xvfb-run -a --server-args="-screen 0 1440x940x24" ./ai-dashboard --no-sandbox
```

This is how the desktop shell was confirmed: window renders, menu drives the
router, `window.open` on an external URL reaches `shell.openExternal` with zero
new Electron windows, and `window.require` / `window.process` are `undefined` in
the renderer.

---

## What comes after the installer

Phases 2–5 are described in `docs/ARCHITECTURE.md`. In order:

- **Phase 2 — GitHub OAuth.** Add an `OAuthGitHubProvider` implementing the
  existing interface, a callback route, and token storage in the `settings` table.
  The hub UI does not change.
- **Phase 3 — Uploads.** Shipped: storage driver, upload and download routes,
  a file panel on the detail page, and an upload-first project flow.
- **Phase 4 — AI.** Shipped: prompt library (CRUD, search over bodies,
  categories, favourites) and an AI workspace hub. Workflows stayed scaffolded —
  they need Phase 5's runner to mean anything.
- **Phase 5 — Automation.** Shipped: task catalogue, in-process scheduler with
  catch-up on launch, run history, and a notification inbox. Not cron — there is
  no always-on server behind a desktop app, and the UI says so.

### Audit follow-ups, all completed

An audit after the installer shipped raised eleven items; all are done. Access
control for networked deployments, crash recovery for the bundled server, a
cached GitHub connection probe, activity-log pruning, a token field in Settings,
in-app update checking with CI-published releases, and Phase 3 uploads. The dead
image config, the page-importing-a-page coupling and the missing `main` branch
were cleared in the same pass; PR #1 now tracks the whole branch.

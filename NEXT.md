# Where this left off

Working notes for the next session. Architecture lives in `docs/ARCHITECTURE.md`;
build and packaging gotchas live in `HANDOFF.md`. This file is only about the
product direction currently in progress.

## The direction

The app is a **personal command center**, not an AI agent platform. Six
priorities, in the order they should be built:

1. **Local projects first-class** — one-click open folder, editor, terminal,
   GitHub, relevant URLs. This is what a desktop app can do that a browser tab
   cannot, so it is the differentiator worth leading with.
2. **A "Today / Focus" view** — active projects, stale work, recent notes,
   unfinished tasks, and the next useful action.
3. **Project context packs** — notes, files, repository link, prompt templates
   and recent activity combined into something exportable to an AI assistant.
   Real AI value without building an agent platform.
4. **Backup / export / import** — a personal dashboard is only trusted once the
   data is demonstrably portable and recoverable. Worth doing early.
5. **Nothing unfinished in primary navigation** — a smaller app where every
   button works beats a larger one full of "coming soon".
6. **Automation is a later product, not a sidebar page.** Reliable jobs need
   logs, retries, cancellation, permissions, secrets, schedules, notifications
   and failure recovery. That is a subsystem.

## Done in this pass

**Item 5 — navigation now only advertises what works.** `/notes` and `/tools`
were pure `PhasePage` placeholders sitting in the sidebar; both are removed from
navigation. The routes still exist and still resolve, so links and bookmarks are
unaffected — they are simply not advertised until they do something. The stale
"Phase 2/3/5" markers are gone: those phases shipped. The Integrations page also
described OAuth, uploads and the AI workspace as upcoming when all three had
shipped; that copy is corrected.

**Item 1 — local project actions, first cut.** A project with a local path now
gets **Open folder**, **Editor** and **Terminal** buttons on its detail page
instead of an inert line of text.

The security shape matters more than the feature here, and is the part to
preserve:

- The renderer **never supplies a path**. It sends a project id and an action
  name; the main process looks the path up from the project the bundled server
  already holds. No argument a page can pass makes this open somewhere else.
- **Nothing goes through a shell.** Every launch uses an argv array, and the
  directory is passed as the child's working directory rather than interpolated
  into a command string, so a path with spaces or semicolons is data.
- Both sides validate. The preload bridge checks the id shape and the action name
  before sending; the main process checks them again on arrival.
- `tests/e2e/desktop.test.ts` asserts the refusals — traversal, an absolute path,
  a shell-looking action, a non-string id, an unknown project — and asserts the
  exposed bridge surface, so widening it accidentally fails the suite.

Editors tried in order: `code`/`code.cmd`, `cursor`, `codium`. Terminals:
Windows Terminal then PowerShell then cmd; Terminal.app on macOS;
`x-terminal-emulator`/`gnome-terminal`/`konsole`/`xterm` on Linux. A missing
candidate fails with ENOENT and the next is tried, so nothing needs configuring.

## Next, in order

**Finish item 1.** Three gaps remain:

- Only the project *detail* page has the buttons. They belong on the project card
  and in the command palette too — "open project X in editor" without navigating.
- There is no way to *pick* a folder. `localPath` is typed by hand into the edit
  form, which is the wrong interaction for a desktop app; it should open a native
  directory picker through the same bridge (`dialog.showOpenDialog`, main-side).
- The launch path is untested on Windows and macOS. Only the refusals are covered
  by tests, because a container has no editor or terminal to launch. Worth a
  manual pass on the real machine before trusting the editor and terminal
  buttons.

**Then item 4 (backup/export/import) before items 2 and 3.** It is self-contained,
it is what makes the rest safe to iterate on, and both later features assume data
worth protecting. A single JSON export of projects, notes, prompts, tags and
settings, plus the uploads directory, with an import that merges rather than
replaces.

**Item 2 needs a decision first.** "Unfinished tasks" implies a task model, and
there is not one — projects have `status` and `notes`, and there is no todo
table. Either derive the Focus view from what exists (stale active projects,
recent activity, unopened projects) and ship it without tasks, or add a task
model first. The first is cheaper and probably right; decide before building.

**Item 6 — `/ai/workflows` is still in the sidebar.** It works and is tested, but
it is one scheduler and two tasks, which is not the subsystem the priority list
describes. It was left in navigation because it does function, which is the
standard item 5 sets. Reconsider when the Focus view lands: if automations are
better expressed as signals inside Focus, the page can go.

## Open from earlier work

- **Auto-update is a check, not an installer.** `electron-updater` would work on
  Windows and Linux using the token the user already stores. macOS needs an
  Apple Developer account for signing and notarisation — a hard requirement.
  Also needs `latest.yml` published, which CI does not currently emit.
- **The GitHub token is stored unencrypted.** Rationale and the cost of moving it
  to the OS keychain are in `docs/ARCHITECTURE.md` §7b.
- **Prompts, notifications, automations, activity and the GitHub cache still talk
  to the database directly**, rather than through repositories the way projects
  do. Deliberate: wide refactor, no correctness win. Revisit only if a second
  storage backend is ever needed.

# Agent workflow

`CLAUDE.md` holds the product, stack and safety rules. They apply to every agent.

## Roles (owner, 28 October 2026)

- **Only two agents work on this project: Claude and Antigravity (`agy`).**
  No other agent (Codex, Gemini, Qwen or others) is used here.
- **Antigravity** implements most rounds. **Claude** plans and assigns precise
  rounds, reviews, tests independently and merges, and may implement a round
  itself when that is faster or Antigravity is unavailable.
- The owner wants a **full review** every round.
- **Rule:** no round merges without an independent review. When Antigravity
  implements, Claude reviews and merges. When Claude implements, Antigravity
  does a read-only review (`REVIEW.md`); Claude answers every finding in
  `REVIEW-RESPONSE.md` (fixed, or rejected with evidence) before running the
  full gates and merging.

### When Claude is out of usage

Antigravity may implement briefed rounds and leave them uncommitted with
`result.md`. Nothing is committed, pushed or merged until Claude is back and
has reviewed it, starting with the newest round folder.

## Where the state lives

- `docs/ROADMAP.md` §10A: AW releases, order and exit criteria. Only the owner
  reorders it.
- `NEXT.md`: the current direction; `HANDOFF.md`: build and packaging gotchas.
- `docs/design/AW-agent-workflow-control-center.md`: §15 is the AW.1 build
  list, §16 covers AW.2–AW.6.
- Outside the repo, on the Windows PC (main clone `H:\Ai Repo clones\Ai-Dashboard`):
  - `H:\Ai Repo clones\.ai-dash-loop\<round>\`: one folder per round with
    `prompt.md`, the implementer log, `result.md`, gate logs and
    `REVIEW.md`;
  - `H:\Ai Repo clones\.ai-dash-loop\REVIEW_CHECKLIST.md`: the review recipe.
- The owner's notes (Obsidian, synced to every machine):
  `Projects/AI Dashboard/` holds `Dashboard.md`, `Decisions Inbox.md` and
  `Rounds/`. The reviewer reads the Decisions Inbox at the start of each
  session and updates the Dashboard and the round note after every round and
  merge.

## Rounds

- One round is one small, exact slice with a written brief (`prompt.md`): goal,
  files in scope, files out of scope, acceptance checks.
- Each round gets its own worktree from the latest `main`. Fetch first so
  `origin/main` is current:
  `git -C "H:/Ai Repo clones/Ai-Dashboard" fetch origin`, then
  `git -C "H:/Ai Repo clones/Ai-Dashboard" worktree add -b <branch> "H:/Ai Repo clones/Ai-Dashboard-<round>" origin/main`.
- Branch names: `roadmap/<round>` for features, `fix/<round>` for fixes,
  `docs/<round>` for docs only.
- Several independent rounds can be combined into one PR to save CI minutes.

## Implementer rules

- Work only in the named worktree. **Never** commit, push, open a PR, reset,
  stash, clean, or install, add or upgrade packages; the reviewer commits and
  pushes.
- Run `npm ci` only when the brief says so. Never edit `package.json` or
  `package-lock.json` unless the brief explicitly includes a dependency
  change the owner approved.
- **No:** real tokens or API keys, the real data folder
  (`%APPDATA%\Command Center\data`), real user databases, or network beyond
  loopback test servers. Tests use `DATABASE_PATH` pointing at a temp file.
- **Agent features stay desktop-only:** in hosted and accounts mode they are
  hidden and their API returns 404. Only the agent runner process spawns
  agents, never the Next.js server.
- Schema changes go through `src/db/schema.ts` plus `npm run db:generate`
  (SQLite) and `src/db/schema.pg.ts` plus `npm run db:generate:pg`
  (Postgres); never hand-edit or delete an existing migration in `drizzle/`
  or `drizzle-pg/`.
- Finish by writing `result.md` in the round folder: what changed, the
  commands run and their results, and anything left undone.

## Reviewer and merger recipe (also for a takeover reviewer)

1. **Rerun the gates independently** in the round's worktree, outside any
   sandbox:
   - `npm run typecheck`
   - `npm run lint`
   - `npm run test:unit`, twice
   - migration drift: `npm run db:generate` (with `DATABASE_PATH` set to a
     temp file) and `npm run db:generate:pg` (any `DATABASE_URL`; generate
     does not connect), then
     `git status --porcelain --untracked-files=all -- drizzle drizzle-pg`
     must be empty
   - `npm run test:e2e` (also proves the production build)
   - `npm run desktop:build`, then `npm run test:desktop` for anything that
     touches `desktop/`, packaging or the data folder
   - `git diff --check`
   CI runs on Node 22; locally use Node 22 when a result differs between
   versions.
2. Mutation-test every new guard on a scratch copy (never the worktree). The
   relevant test must fail.
3. **Review:** scope honoured, no secrets stored or shown, agent features stay
   desktop-only (hidden and 404 in hosted and accounts mode), wording plain and
   short. For UI rounds, also walk through the page in the browser or desktop
   app.
4. **On GREEN:**
   - commit with a scoped message, excluding build output and `build.log`;
   - push and open a PR (batch rounds when it saves CI minutes);
   - wait for all required checks on the **exact** head;
   - `gh pr merge <n> --merge --match-head-commit <sha>`;
   - verify with `git merge-base --is-ancestor <sha> origin/main`;
   - remove the round's worktree.
5. **On a CI failure:** read the failing log and find the root cause before
   rerunning. Treat possible data loss or a desktop-only guard leaking into
   hosted mode as P1 until it is proven to be test-only.
6. No tags, releases, installer publishing or deploys without the owner's
   explicit go-ahead.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

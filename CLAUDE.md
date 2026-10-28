# Command Center — notes for Claude

A personal project operating system: one place to see, organise, launch and
manage the owner's projects (GitHub repos, uploaded and manual projects). Since
12 October 2026 the product is the **Agent Workflow Control Center**: pick a
local project and an implementer, then watch a bounded plan → implement →
check → review → correction loop. Nothing merges, pushes or publishes without
the owner's approval.

@AGENTS.md holds the round workflow, roles, the reviewer and merger recipe,
and the Next.js 16 rules block. Follow it.

## Where to look first

- `NEXT.md`: the current direction and what the last pass did.
- `docs/ROADMAP.md` §10A and `docs/design/AW-agent-workflow-control-center.md`
  (§15 is the AW.1 build list).
- `HANDOFF.md`: build and packaging bugs already fixed. Do not reintroduce
  them.
- `docs/ARCHITECTURE.md`, `docs/CI_RULES.md`: open them when the task points
  there.

## Stack

Next.js 16 + React + TypeScript, Drizzle ORM on SQLite (desktop and
single-user web) or Postgres (hosted multi-user mode), and an Electron shell
in `desktop/`. One codebase serves both desktop and web.

## Commands

```bash
npm run dev                 # web, http://localhost:3000
npm run desktop:dev         # desktop window
npm run typecheck
npm run lint
npm run test:unit           # tests/unit/*.test.ts
npm run test:e2e            # builds first, then end-to-end
npm run desktop:build && npm run test:desktop
npm run db:generate         # after editing src/db/schema.ts; commit drizzle/
```

CI (`.github/workflows/ci.yml`) runs these on Node 22. A PR that touches only
docs takes the light path and skips the code jobs.

## Rules

- **Agent features are desktop-only.** In hosted and accounts mode they are
  hidden and their API returns 404. A server that launches CLI processes
  against filesystem paths must never be reachable by anyone but the local
  user.
- Only the agent runner process (forked by Electron) spawns agents. The
  Next.js server records intents and streams events; it never spawns.
- Migrations only add: change `src/db/schema.ts`, run `npm run db:generate`,
  and commit the result. Never edit or delete a shipped migration.
- The user's data lives in the per-user app data folder (see README). Never
  touch it in tests or rounds; use `DATABASE_PATH` with a temp file.
- Tokens (GitHub, AI providers) are never committed, logged or included in an
  export. `.env.example` holds dummy values only.
- Anchor new `.gitignore` patterns with a leading slash (see `NEXT.md` for the
  `uploads/` incident).
- No new dependencies without the owner agreeing.
- Never tell anyone to bypass SmartScreen or Defender, or to weaken any
  operating-system protection.

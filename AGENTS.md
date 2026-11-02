# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, Codex, etc.) when working with code in this repository.

## What this is

`bull-cli` is a terminal dashboard (TUI) for BullMQ job queues — the `bull-board` equivalent for
the terminal, built with Ink 6 + React 19. It auto-discovers queues on a Redis instance (no config
file) and lets you browse queues, jobs, and job detail, and run actions (retry/delete/promote/
pause/drain) without leaving the shell. See `README.md` for the full keybinding table and layout.

## Commands

```
npm run redis:up            # starts a local redis:7-alpine container (docker compose), required
                             # for integration/e2e tests and for `npm run dev`/`npm run seed`
npm run dev                  # runs the CLI against local Redis via tsx (no build step)
npm run seed                  # populates local Redis (db 0) with demo queues/jobs
npm run seed -- --hold        # also holds one job "active" for ~60s (Active tab demo)

npm test                     # unit tests only — no Redis required
npm run test:integration     # integration + e2e projects — requires `npm run redis:up` first
npm run test:all             # every vitest project (unit + integration + e2e)
npm run coverage             # full coverage run across all projects, enforces the thresholds below

npm run lint                  # biome check .
npm run typecheck             # tsc --noEmit
npm run build                  # tsc -p tsconfig.build.json -> dist/
npm run redis:down             # stops and removes the local redis container
```

Run a single test file or test case directly with vitest (works for any of the three projects):

```
npx vitest run tests/unit/store.test.ts
npx vitest run tests/unit/ui/Tabs.test.tsx -t "positional stability"
npx vitest run --project integration tests/integration/jobs.test.ts
```

Coverage thresholds (`vitest.config.ts`, enforced by `npm run coverage`): `src/core/**` and
`src/config.ts` require ≥90% lines/branches; `src/ui/**` requires ≥80%. `src/cli.tsx` is excluded
from coverage entirely (it's the process entrypoint, exercised only manually/e2e).

Integration and e2e tests each use their own Redis **logical DB** (not DB 0, so they never collide
with `npm run seed` or each other): discovery=1, jobs=2, actions=3, e2e=4, wiring=5, registry=13,
jsonOutput=6, schedulers=7, doctor=8, retry=9, redis=14, sanity=15.

## Architecture

### Layering: `core` is framework-agnostic, `ui` is pure presentation

`src/core/**` is a plain TypeScript state machine with **zero** `ink`/`react` imports — this is a
hard rule stated directly in `store.ts`'s class doc, not just a convention. Everything driving
dashboard behavior (tabs, pagination, search, refresh/polling, focus, modal, drain confirmation,
toasts, action dispatch, connection/error handling) lives in `DashboardStore`
(`src/core/store.ts`), which is unit-tested with plain fakes and has no dependency on Redis or
bullmq types beyond the shapes in `src/core/types.ts`.

`src/ui/**` (Ink/React components) is deliberately thin: `App.tsx` subscribes to the store via
`useStore` (`useSyncExternalStore`) and renders whatever the current `DashboardSnapshot` says;
`useKeymap` is the single `useInput` dispatcher that translates every keybinding into a store
method call. No UI component holds its own state machine logic — if behavior needs to change,
it almost always changes in `store.ts`, not in a component.

### Store ↔ real world: `StoreDeps` and `wiring.ts`

`DashboardStore` never talks to Redis/bullmq directly — it depends only on the `StoreDeps`
interface (`discoverQueues`, `fetchJobPage`, `getJobDetail`, an `actions` bag, `syncRegistry`),
expressed purely in terms of queue **names**, never `Queue` instances. `src/wiring.ts`'s
`createApp()` is the only place that wires those deps to the real adapters:
- `discovery.ts` — finds queues via cursor-based `SCAN` for `<prefix>:*:meta` keys (never `KEYS`),
  reads paused state with a pipelined `HEXISTS`.
- `queueRegistry.ts` — lazily creates and caches one `bullmq.Queue` per name, closing evicted ones
  on `sync()`.
- `schedulers.ts` — `fetchSchedulerPage`/`getSchedulerDetail`/`fetchSchedulerCount` for the
  read-only Schedulers tab (`Tab = JobStatus | 'schedulers'`; `JobStatus` itself is unchanged).
- `jobs.ts` — `fetchJobPage`/`getJobDetail`, including bullmq's queue-count/pagination quirks (a
  paused queue's `waiting` jobs live in the `paused` bucket, folded together for the tab count).
- `actions.ts` — retry/delete/promote/pause/resume/drain; **never throws**, every failure
  normalizes to `{ ok: false, message }` so the store can surface it as a toast uniformly.

A `Queue` name containing `:` is legal in Redis (written by another client/older bullmq) but
`new Queue(name, ...)` throws *synchronously* for it — `wiring.ts`'s `safeFetch`/`safeAction`
wrappers are what convert that throw into the shape each call site already expects (a rejected
promise, or `{ ok: false }`) instead of letting it escape uncaught.

### `bull-cli doctor` (`src/core/doctor.ts`)

`runDoctor(deps)` runs a fixed, ordered list of checks (config, connection, ping, server, queues),
never aborting early; once `ping` fails the Redis-dependent checks are `skip`. Everything external
(fs, Redis client factory, clock, env) is injected, so it's unit-tested with fakes. The client comes
from `createDoctorRedisClient` in `redis.ts` (fail-fast, unlike the dashboard's retrying client).
`cli.tsx` dispatches `doctor` before the fail-fast config loading, so a broken config file is a failed
check rather than an early exit. `EmptyState` shows prefix/DB hints and points at `doctor`.

### Refresh/polling model

`refresh()` is coalescing, not queued: a call while one is already in flight sets a "trailing
refresh" flag rather than stacking concurrent fetches. Every `refresh()` call (manual `R`, the 3s
poll tick, or any navigation) restarts the poll interval, so "manual refresh resets the interval"
falls out of one code path rather than a special case. A monotonically increasing
`refreshGeneration` counter is the invalidation mechanism: any navigation that changes what an
in-flight fetch would otherwise write back (`selectQueue`, `selectTab`, paging, job selection)
bumps it, and `doRefreshWork` checks `myGen !== this.refreshGeneration` after every `await` so a
stale, slow-resolving fetch can never clobber fresher state. `discoverQueues()` failures are
connection-level and propagate to a full-screen error state; everything after that (per-queue
`fetchJobPage`) is caught individually so one un-openable queue doesn't take down the whole
dashboard.

### Terminal lifecycle (`cli.tsx` / `terminal.ts`)

The CLI refuses to start without a TTY, then enters the terminal's alternate screen buffer
(`\x1b[?1049h`, `terminal.ts`) before the first Ink frame renders, so quitting restores the shell
exactly as it was with no dashboard frames in scrollback. Because Ink's own `exitOnCtrlC` would
otherwise unmount without running cleanup, `cli.tsx` routes every exit path (`q`, Ctrl+C, SIGINT/
SIGTERM, `instance.waitUntilExit()`, uncaught exceptions) through one idempotent `shutdown()` that
unmounts Ink, leaves the alt screen, and calls `app.stop()` (stops polling, closes cached queues,
disconnects ioredis) before `process.exit()`.

### Connection precedence and config resolution

`src/config.ts` resolves the Redis URL and BullMQ key prefix with the same precedence pattern:
CLI flag > env var (`REDIS_URL` / `BULLMQ_PREFIX`) > default. These resolvers are pure functions
(env injected, not read from `process.env` directly) so they're unit-testable without process
mutation. `connectionFromUrl` parses the resolved URL into the discrete options ioredis/bullmq
expect, independently of what `redis.ts` hands ioredis directly as a URL string — kept at parity
deliberately (see the comment in `config.ts`) so TLS (`rediss:`) and IPv6-bracket-stripping behave
identically in both places.

## Releasing a version

The package is published to npmjs.com as `@angelkar/bull-cli` (public, via `publishConfig`). No CI
workflow publishes it; releases are done by hand from a local checkout. Not to GitHub Packages:
that registry needs users to authenticate even for public packages, and its scope would have to be
the GitHub owner (`@ang3lkar`), not `@angelkar`.

Publishing, pushing and creating a release are all public and hard to undo — confirm with the user
before each one unless they've asked for that step.

1. **Bump the version** with `npm version patch|minor|major`. This makes a commit (message is the
   bare version, e.g. `0.1.1`) and an annotated `vX.Y.Z` tag, both local only. The user usually
   does this step themselves.
2. **Draft the release notes and stop for review.** Write them (see below) to a file in the
   scratchpad, give the user its full absolute path, and wait. They may edit the file directly.
   Don't publish, push or release until they say the notes are ready, and re-read the file
   afterwards so step 6 uses their edited version.
3. **Publish to npm** with `npm publish`. `prepublishOnly` runs lint, typecheck, unit tests and the
   build first. Run `npm publish --dry-run` beforehand to check the package contents. The user must
   be logged in to npm (`npm whoami` returns 401 otherwise); ask them to run `! npm login`
   themselves, and to have a 2FA code ready.
4. **Verify** with `npm view @angelkar/bull-cli time --json --prefer-online`. Without
   `--prefer-online`, `npm view` can show a cached copy that still lacks the new version.
5. **Push** the version commit and its tag together: `git push origin main vX.Y.Z`. The tag points
   at the version commit, so `main` must go up with it.
6. **Create the GitHub Release** with `gh release create vX.Y.Z --verify-tag --title "vX.Y.Z"
   --notes-file <notes.md>`. `v0.1.0` was published without a GitHub Release.

Release notes are written for people who use the tool, from `git log vPREV..vX.Y.Z`:
- A one-line summary, then `## Fixed` and `## Improved` sections (omit an empty one), and an
  `## Install` section with `npm install -g @angelkar/bull-cli@X.Y.Z`.
- Describe each change by what the user sees, not how it was built.
- Leave out commits that don't change the installed tool: seed script, CI, tests, the project page
  (`site/`), docs.

`gh` and `npm` calls that reach the network fail inside the Bash sandbox (TLS/socket errors) and
need to run outside it.

## Multi-agent implementation pipeline

This repo has dedicated subagents for feature work — `implementer`, `tester`, `reviewer`
(defined in `.claude/agents/`) — for a plan → implement → test → review workflow.

**Only use this pipeline when the user explicitly asks for it** (e.g. "use the
pipeline", "run this through implementer/tester/reviewer", "use the subagents").
Do not invoke it automatically for feature work, bug fixes, or UI changes — handle
those directly by default.

When the pipeline is explicitly requested:
1. Write the plan/spec yourself.
2. Delegate to `implementer` with the spec and relevant files.
3. Delegate to `tester` with the diff; it ends with `RESULT: PASS` or `RESULT: FAIL`.
4. On FAIL, send the failure details back to `implementer`; repeat up to 5 times,
   then stop and report rather than looping forever.
5. On PASS, delegate to `reviewer` with the full diff.
6. Treat a reviewer verdict of NEEDS CHANGES like a tester FAIL — loop back to
   `implementer` with the reviewer's required changes, then re-test and re-review.
7. Present the reviewer's final findings to the user as the summary of the work.

Give each subagent a self-contained prompt — they have no memory of prior
sessions. Resume a subagent that got cut off via its agent handle rather than
relaunching it from scratch.

## Agent skills

### Issue tracker

Issues live in the `ang3lkar/bull-cli` GitHub Issues, managed with the `gh` CLI. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, using the default label strings. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.

# bull-cli

A terminal dashboard (TUI) for [BullMQ](https://github.com/taskforcesh/bullmq) job queues — the
`bull-board` equivalent for your terminal. Point it at a Redis instance and browse queues, jobs,
and job details without leaving the shell.

## Install

```
npm install -g bull-cli
```

Requires Node.js >= 20 and a reachable Redis instance with one or more BullMQ queues (auto-discovered
by scanning for `bull:*:meta` keys — no configuration file needed).

## Usage

```
bull-cli [options]

Options:
  --redis <url>      Redis connection URL (overrides REDIS_URL env var)
  --prefix <prefix>  BullMQ key prefix (overrides BULLMQ_PREFIX env var)
  -h, --help         Show help
  -v, --version      Show version
```

Connection precedence (highest wins):

1. `--redis <url>` flag
2. `REDIS_URL` environment variable
3. `redis://localhost:6379` (default)

Credentials, if any, are embedded in the URL itself:

```
redis://:password@host:6379
redis://username:password@host:6379
```

BullMQ prefix precedence (highest wins):

1. `--prefix <prefix>` flag
2. `BULLMQ_PREFIX` environment variable
3. `'bull'` (bullmq's own default)

Examples:

```
bull-cli
bull-cli --redis redis://localhost:6379
REDIS_URL=redis://:secret@redis.internal:6379 bull-cli
bull-cli --prefix myapp
```

`bull-cli` requires an interactive terminal (TTY) — it refuses to start when stdin isn't a TTY
(e.g. piped input or a non-interactive CI shell).

It runs fullscreen, in the terminal's alternate screen buffer (like vim or htop); quitting —
`q`, `Ctrl+C`, or a `kill` — restores the shell exactly as it was, with no dashboard frames left
in scrollback.

## Layout

```
┌─────────────────────────────────────────────────────────┐
│  sidebar  │  Active | Waiting | Completed | Failed | Delayed │
│           │─────────────────────────────────────────────│
│ emailQ    │  ID  │ Name │ Attempts │ Timestamp │ Progress │
│ smsQ ⏸   │ ──────────────────────────────────────────── │
│ reportQ   │  ...                                         │
│           │                                              │
│           │                              Page 1 of 5 ›  │
├─────────────────────────────────────────────────────────┤
│ redis://localhost:6379    Last updated: 2s ago    / search  R refresh  q quit │
└─────────────────────────────────────────────────────────┘
```

- **Sidebar** — every discovered queue, alphabetically, with a `⏸` next to paused ones.
- **Tabs** — five job statuses per queue: Active, Waiting, Completed, Failed, Delayed.
- **Job list** — ID, Name, Attempts, Timestamp, Progress; newest first, 10 per page.
- **Job detail modal** (`Enter`) — pretty-printed `data`, `returnvalue`, `stacktrace` (failed jobs),
  timestamps, and `opts`.
- **Footer** — active Redis URL (password masked), `Last updated: Ns ago`, key hints.

Both the queue list and job list refresh automatically every 3 seconds, or immediately on `R`.

Search (`/`) filters the job list by ID or name as you type. `Enter` accepts the current filter and
closes the search input (the filtered list stays applied); `Escape` clears the filter entirely and
returns to the full list.

## Keyboard bindings

### Global

| Key | Action |
|---|---|
| `q` | Quit |
| `R` | Manual refresh |
| `Tab` | Switch focus: sidebar ↔ job list |
| `Escape` | Close modal / clear search |

### Sidebar (focused)

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate queues |
| `p` | Toggle pause/resume queue |
| `Shift+D` | Drain queue (with confirmation prompt) |

### Job list (focused)

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate jobs |
| `←` / `→` or `1`–`5` | Switch status tabs |
| `PgUp` / `PgDn` | Paginate job list |
| `Enter` | Open job detail modal |
| `/` | Open search bar (filters by job ID or name) |
| `r` | Retry job (failed jobs only) |
| `d` | Delete job |
| `p` | Promote delayed job to waiting |
| `Shift+D` | Drain queue (with confirmation prompt) |

## Development

```
npm install
npm run redis:up          # starts a local redis:7-alpine container (docker compose)
npm run dev                # runs the CLI against local Redis via tsx
npm run seed                # populates local Redis with demo queues/jobs
npm run seed -- --hold      # also holds one job "active" for ~60s (Active tab demo)
```

To run the dev CLI against a custom Redis, use the same options as the installed binary — the
`--redis` flag beats `REDIS_URL`, and both beat the `redis://localhost:6379` default. The `--`
separator is required so npm forwards the flag to the CLI instead of consuming it:

```
npm run dev -- --redis redis://:password@myhost:6379
REDIS_URL=redis://myhost:6379 npm run dev
```

```
npm test                    # unit tests (no Redis required)
npm run test:integration    # integration + e2e tests (requires npm run redis:up first)
npm run coverage            # full coverage run across all test projects

npm run lint                 # biome check
npm run typecheck            # tsc --noEmit
npm run build                 # tsc -> dist/
npm run redis:down            # stops and removes the local redis container
```

Requirements for running the test suite: Node.js >= 20 and Docker (for `npm run redis:up`).
Integration and e2e tests each use a dedicated Redis logical DB (separate from DB 0) so they never
collide with each other or with data seeded via `npm run seed` (which targets DB 0, the default).

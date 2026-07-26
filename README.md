# bull-cli

A terminal dashboard (TUI) for [BullMQ](https://github.com/taskforcesh/bullmq) job queues — the
`bull-board` equivalent for your terminal. Point it at a Redis instance and browse queues, jobs,
and job details without leaving the shell.

## Install

```
npm install -g bull-cli
```

Requires Node.js >= 20 and a reachable Redis instance with one or more BullMQ queues (auto-discovered
by scanning for `bull:*:meta` keys — no configuration file is required to get started).

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

## Configuration

Everything works with zero configuration. An optional JSONC (JSON with `//` and `/* */` comments,
and trailing commas allowed) config file lets you override defaults that aren't worth a CLI flag —
currently just the dashboard's auto-refresh interval.

Two locations are checked, both optional; if a project file is present, it's merged over the user
file key-by-key:

1. `bull-cli.json` in the current directory (project-level)
2. `$XDG_CONFIG_HOME/bull-cli/config.json`, or `~/.config/bull-cli/config.json` if
   `XDG_CONFIG_HOME` isn't set (user-level)

```jsonc
// bull-cli.json (or ~/.config/bull-cli/config.json)
{
  // How often the dashboard polls Redis for updates, in milliseconds.
  // Must be an integer >= 250. Defaults to 3000.
  "refreshIntervalMs": 3000,
}
```

A present-but-invalid config file (bad JSON, an unrecognized key, or an out-of-range value) is a
hard error — `bull-cli` prints the problem to stderr and exits rather than silently ignoring it.
A missing file is perfectly fine and just falls back to defaults.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ bull-cli - v0.1.0   Queues > emailQ                                      │
│ [Esc/h] Back    [r] Refresh    [q] Quit                                  │
│                                                                          │
│ [↑/↓] Move      [1-5] Status    [Enter] Detail    [/] Filter             │
│                                                                          │
│ Jobs — emailQ                                                           │
│ [Delayed](0) | Waiting (12) | Active (2) | Failed (1) | Completed (4)  │
│                                                                          │
│    ID          Name                 State     Attempts  CreatedAt        │
│ ❯ 12          send-email            waiting          0  2026-07-26 ...  │
│    ...                                                                   │
│                                                                          │
│                                                          Page 1 of 2      │
│ redis://localhost:6379                            Last updated: 2s ago  │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Queue list** — a full-width list with the queue name and lifecycle counters in order:
  delayed, waiting, active, failed, completed. Paused queues carry a `⏸` marker.
- **Job list** — a full-width `ID`, `Name`, `State`, `Attempts`, `CreatedAt` table. The name
  column expands to fill the terminal. The status header provides counts and selection feedback.
- **Job detail** — queue and job metadata, pretty-printed data, return value, stacktrace, and
  options.
- **Header** — breadcrumbs identify the active location (`Queues > emailQ > job #43`) and a
  k9s-style shortcut grid separates basic shortcuts (yellow) from contextual ones (cyan).
- **Status bar** — a compact Redis URL (password masked) and last-refresh timestamp.

Only one view is visible at a time. `Enter` drills into the selected row; `Escape` or `h` returns to
the previous screen. Opening a queue starts on the **Delayed** status; use the status shortcuts to
choose another bucket. Data refreshes automatically every 3 seconds, or immediately on `r`.

Search (`/`) filters the job list by ID or name as you type. `Enter` accepts the current filter and
closes the search input (the filtered list stays applied); `Escape` clears the filter entirely and
returns to the full list.

When a status has no jobs, the list shows a contextual empty state instead of pagination and points
to populated status buckets with their numeric shortcuts.

## Keyboard bindings

### Basic

| Key | Action |
|---|---|
| `q` | Quit |
| `r` | Manual refresh |
| `Esc` / `h` | Return to the previous view (outside the queue dashboard) |

### Queue list

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate queues |
| `Enter` | Open selected queue's jobs |
| `p` | Toggle pause/resume queue |
| `Shift+D` | Drain queue (with confirmation prompt) |

### Job list

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate jobs |
| `1` | Delayed jobs |
| `2` | Waiting jobs |
| `3` | Active jobs |
| `4` | Failed jobs |
| `5` | Completed jobs |
| `b` / `n` | Previous / next page of the job list |
| `Enter` | Open job detail |
| `/` | Open search bar (filters by job ID or name) |
| `R` | Retry job (failed jobs only; shown only for Failed) |
| `Shift+D` | Delete job (with confirmation prompt) |
| `p` | Promote a delayed job to waiting (shown only for Delayed) |
| `c` | Duplicate job — clones its payload as a new delayed job (with confirmation prompt) |

### Job detail

| Key | Action |
|---|---|
| `R` | Retry the shown job (failed jobs only) |
| `Shift+D` | Delete the shown job (with confirmation prompt when supported) |
| `c` | Copy the job data JSON to the clipboard |
| `Esc` / `h` | Return to the job list |

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

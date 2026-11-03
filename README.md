# bull-cli

[![npm downloads](https://img.shields.io/npm/dm/@angelkar/bull-cli)](https://www.npmjs.com/package/@angelkar/bull-cli)
[![Tests](https://github.com/ang3lkar/bull-cli/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ang3lkar/bull-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@angelkar/bull-cli)](https://www.npmjs.com/package/@angelkar/bull-cli)

A terminal dashboard (TUI) for [BullMQ](https://github.com/taskforcesh/bullmq) job queues — the
`bull-board` equivalent for your terminal. Point it at a Redis instance and browse queues, jobs,
and job details without leaving the shell.

![bull-cli browsing queues, opening a failed job and retrying it](docs/demo.gif)

## Why bull-cli?

[bull-board](https://github.com/felixmosh/bull-board) is a web UI that you add to your app's
server. bull-cli covers the same day-to-day work without that:

- **You never leave the terminal.** Browse queues and jobs, read failures, and retry, promote,
  delete or drain from the shell you're already in. Nothing to add to your app, no server to run
  or expose: just point it at Redis.
- **Stats as JSON.** `bull-cli --output json` prints every queue's counts as JSON, ready for `jq`,
  scripts, cron jobs or CI checks. No dashboard, no interactive terminal needed.

### Who it's for

Developers and on-call engineers who run BullMQ and live in the terminal: you want to see what
your queues are doing without opening a browser, or your app doesn't have bull-board set up at
all.

### When to use it

- **Local development:** watch jobs flow through your queues while you work on a worker.
- **Debugging a failure:** find the failed job, read its error and stack trace, fix the code and
  retry it, all in one place.
- **Incidents and production checks:** connect to a Redis you can reach (directly, over SSH or
  through a `kubectl port-forward`) and see queue health straight away, with nothing deployed.
- **Scripts and monitoring:** feed `--output json` into a cron job, a CI step or an alert, e.g.
  "fail if any queue has failed jobs".

Prefer bull-board when you want a dashboard your whole team can open in a browser, including
people who don't use a terminal.

## Install

Try it without installing:

```
npx @angelkar/bull-cli --redis redis://localhost:6379
```

Or install it globally:

```
npm install -g @angelkar/bull-cli
```

Requires Node.js >= 20 and a reachable Redis instance with one or more BullMQ queues (auto-discovered
by scanning for `bull:*:meta` keys — no configuration file is required to get started).

## Usage

```
bull-cli [options]
bull-cli doctor [options]   # diagnose config, connection and queue discovery
bull-cli retry --queue <name> (--dry-run | --yes) [--job-id <id> | --since <duration>]

Options:
  --redis <url>      Redis connection URL (overrides REDIS_URL env var)
  --prefix <prefix>  BullMQ key prefix (overrides BULLMQ_PREFIX env var)
  --profile <name>   Connection profile from the config file (default: "defaultProfile")
  --output <format>  Output mode (supported: json)
  --queue <name>     Queue filter for --output=json; the queue to act on for retry
  --job-id <id>      retry: only this failed job
  --since <duration> retry: only jobs that failed within this window (30s, 15m, 2h, 7d, 1w)
  --dry-run          retry: report what would be retried without changing anything
  --yes              retry: actually retry
  -h, --help         Show help
  -v, --version      Show version
```

## Troubleshooting

If the dashboard shows no queues, the usual cause is a wrong key prefix or logical DB. Run:

```
bull-cli doctor
```

It checks your config files, the resolved connection (and where each setting came from), `PING`
latency, the Redis server, and queue discovery, and hints at a likely fix (e.g. `Try --prefix myapp`).
It keeps going after a failure and exits 1 if any check failed. Add `--output json` for
machine-readable output. Passwords are always masked.

Connection precedence (highest wins):

1. `--redis <url>` flag
2. `REDIS_URL` environment variable
3. the selected [connection profile](#connection-profiles)'s `redisUrl`
4. `redis://localhost:6379` (default)

Credentials, if any, are embedded in the URL itself:

```
redis://:password@host:6379
redis://username:password@host:6379
```

BullMQ prefix precedence (highest wins):

1. `--prefix <prefix>` flag
2. `BULLMQ_PREFIX` environment variable
3. the selected [connection profile](#connection-profiles)'s `prefix`
4. `'bull'` (bullmq's own default)

Examples:

```
bull-cli
bull-cli --redis redis://localhost:6379
REDIS_URL=redis://:secret@redis.internal:6379 bull-cli
bull-cli --prefix myapp
bull-cli --profile staging
bull-cli --output=json
bull-cli --output=json --queue=email
```

`bull-cli` requires an interactive terminal (TTY) — it refuses to start when stdin isn't a TTY
(e.g. piped input or a non-interactive CI shell), unless `--output=json` is used.

### JSON output mode

`--output=json` skips the dashboard and prints queue data as JSON to stdout:

```json
{
  "queues": [
    {
      "name": "email",
      "isPaused": false,
      "counts": {
        "active": 0,
        "waiting": 3,
        "completed": 10,
        "failed": 1,
        "delayed": 0
      }
    }
  ]
}
```

Notes:

- `--queue=<name>` filters output to a single queue.
- `--queue` requires `--output=json`.
- Unknown queue names return an error and exit with status `1`.

### Retrying failed jobs from a script

`bull-cli retry` moves failed jobs back to waiting without opening the dashboard. It needs no TTY,
so it works in CI, cron jobs and incident runbooks:

```sh
bull-cli retry --queue email --dry-run              # how many would be retried?
bull-cli retry --queue email --yes                  # retry every failed job
bull-cli retry --queue email --since 2h --yes       # only jobs that failed in the last 2 hours
bull-cli retry --queue email --job-id 42 --yes      # just one job
```

It always prints a JSON summary:

```json
{
  "queue": "email",
  "dryRun": false,
  "filter": { "failedSince": "2026-11-02T10:00:00.000Z" },
  "matched": 3,
  "retried": 2,
  "errored": 1,
  "errors": [{ "jobId": "17", "message": "Job 17 not found" }]
}
```

Notes:

- It changes data, so it refuses to run unless you pass `--dry-run` or `--yes` (exactly one).
- `--since` takes a number and a unit: `s`, `m`, `h`, `d` or `w`. It can't be combined with
  `--job-id`.
- `errored` counts matched jobs whose retry failed. Problems that aren't about a matched job (no
  connection, a missing queue, a `--job-id` that isn't failed) appear only in `errors`.
- The exit status is `1` if `errors` is non-empty: a retry failed, the queue doesn't exist, or
  Redis can't be reached. Otherwise it's `0`.

It runs fullscreen, in the terminal's alternate screen buffer (like vim or htop); quitting —
`q`, `Ctrl+C`, or a `kill` — restores the shell exactly as it was, with no dashboard frames left
in scrollback.

## Configuration

Everything works with zero configuration. An optional JSONC (JSON with `//` and `/* */` comments,
and trailing commas allowed) config file lets you override defaults that aren't worth a CLI flag —
the dashboard's auto-refresh interval and its per-refresh timeout, plus named
[connection profiles](#connection-profiles).

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

  // How long a single refresh cycle may run before it's abandoned and the
  // connection is shown as errored, in milliseconds.
  // Must be an integer >= 250. Defaults to 5000.
  //
  // Raise this for a Redis reached over a high-latency link (a tunnelled or
  // remote instance): queue discovery walks the keyspace with SCAN, so its
  // cost is round trips × latency, and on a large shared database it can
  // legitimately exceed the default while Redis is perfectly reachable.
  // Keep it comfortably above "refreshIntervalMs".
  "refreshTimeoutMs": 5000,
}
```

### Connection profiles

Named connections save retyping the URL and prefix when you switch between Redis instances. Add
them to either config file and pick one with `--profile <name>`, or set `defaultProfile` to use one
when no flag is given:

```jsonc
// ~/.config/bull-cli/config.json
{
  "defaultProfile": "local",
  "profiles": {
    "local": { "redisUrl": "redis://localhost:6379" },
    "staging": { "redisUrl": "redis://staging.internal:6379", "prefix": "myapp" },
    // Read from the environment, so the password never lands in the file.
    "prod": { "redisUrl": "${PROD_REDIS_URL}", "prefix": "myapp" },
  },
}
```

- Each profile needs a `redisUrl`; `prefix` is optional and falls back to `bull`.
- A value written exactly as `${VAR}` is read from that environment variable when the profile is
  used. An unset or empty variable is an error. Only the whole value is substituted:
  `redis://${HOST}:6379` is used as written.
- A profile only fills in what the flags and environment leave open: `--redis` / `REDIS_URL` and
  `--prefix` / `BULLMQ_PREFIX` still win over it. `bull-cli doctor` shows where each value came
  from, e.g. `(profile "prod")` or `(REDIS_URL)`.
- When both files define profiles, they're combined. A project profile replaces a user profile of
  the same name entirely, and the project file's `defaultProfile` wins.
- An unknown profile name is an error that lists the profiles you do have.

A present-but-invalid config file (bad JSON, an unrecognized key, or an out-of-range value) is a
hard error — `bull-cli` prints the problem to stderr and exits rather than silently ignoring it.
A missing file is perfectly fine and just falls back to defaults.

## Layout

- **Queue list** — a full-width list with the queue name and lifecycle counters in order:
  delayed, waiting, active, failed, completed. Paused queues carry a `(paused)` marker. The
  heading shows the current sort, and `/` filters the list by name. A metrics row above the list
  totals each counter across all queues (the name filter doesn't change it) and shows throughput:
  completed and failed jobs per minute, averaged over the last minute of refreshes. Throughput
  reads `—` until the second refresh. It is worked out from how the counts grow, so a queue whose
  jobs use `removeOnComplete` / `removeOnFail` adds nothing to it, and a `clean` counts as zero
  rather than a negative rate.
- **Job list** — a full-width `ID`, `Name`, `State`, `Attempts`, `CreatedAt` table. The name
  column expands to fill the terminal. The status header provides counts and selection feedback.
  A page holds as many rows as fit the terminal's height, so `Page N of M` is accurate at any
  size. Resizing re-pages the list and keeps the selected job on screen. In a short terminal
  (under 24 rows) the blank spacer lines collapse to make room.
- **Schedulers** — the sixth tab of the job list: the queue's BullMQ job schedulers (repeatable
  jobs), soonest next run first, with `Key`, `Name`, `Schedule` (cron pattern or `every 5m`),
  `TZ`, `Next run` and `Iterations` columns. Read-only.
- **Scheduler detail** — a scheduler's schedule, timezone, next run, start/end dates, iterations,
  offset and next job on the left; its job template (data and options) on the right. `Enter`
  opens the next delayed job, and `Esc` brings you back. It reloads on every refresh.
- **Job detail** — job metadata on the left (ID, name, state, dates, how long the job waited and
  ran, attempts out of the limit, progress, options); the failure reason, data, return value and
  stack trace on the right, with the first frame from your own code highlighted. It reloads on
  every refresh, so it follows the job through a retry, a worker picking it up, and completion.
- **Title bar** — the app's identity (`bull-cli v0.1.0`) and nothing else; the breadcrumb reports
  location, so the title bar never repeats it.
- **Legend** — a k9s-style shortcut grid separating always-available keys (yellow) from
  view-contextual ones (cyan). It reserves a fixed height, so the breadcrumb and everything
  below it stay on the same row as you navigate.
- **Breadcrumb** — the current location above the body content, one crumb per level of the
  navigation stack: `Queues`, `Queues > emailQ`, `Queues > emailQ > failed > job #43`,
  `Queues > emailQ > schedulers > daily-digest`.
- **Status bar** — a compact Redis URL, with any password masked, and the BullMQ key prefix.

Only one view is visible at a time. `Enter` drills into the selected row; `Escape` or `h` returns to
the previous screen, and `H` jumps all the way back to the queue dashboard from wherever you are.
Opening a queue starts on the **Delayed** status; use the status shortcuts to choose another bucket.
Data refreshes automatically every 3 seconds, or immediately on `r`.

Search (`/`) filters the current page of the job list by ID or name as you type. `Enter` accepts the
current filter and closes the search input (the filtered list stays applied); `Escape` clears the
filter entirely and returns to the full list.

When a status has no jobs, the list shows a contextual empty state instead of pagination and points
to populated status buckets with their numeric shortcuts. An empty list that is *not* an empty
status is labelled as such: while a page is still being fetched it says so rather than reporting
zero jobs, and a search that matches nothing names the query instead of the status.

## Keyboard bindings

### Basic

| Key | Action |
|---|---|
| `q` | Quit |
| `r` | Manual refresh |
| `Esc` / `h` | Return to the previous view (outside the queue dashboard) |
| `Shift+H` | Jump straight back to the queue dashboard, from any depth |

### Queue list

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate queues |
| `Enter` | Open selected queue's jobs |
| `p` | Toggle pause/resume queue |
| `Shift+D` | Drain queue (with confirmation prompt) |
| `s` | Cycle the sort: name, total, failed, waiting, active, delayed (counts sort highest first) |
| `/` | Filter queues by name (`Enter` keeps the filter, `Esc` clears it) |
| `Esc` | Clear an accepted filter |

While the filter input is open, every key (including `q`, `s`, `p`, `Shift+D`) types a character;
`Ctrl+C` still quits. The filter stays applied when you enter a queue and come back.

### Job list

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate jobs |
| `←` / `→` | Previous / next tab (clamped at Delayed and Schedulers) |
| `1` | Delayed jobs |
| `2` | Waiting jobs |
| `3` | Active jobs |
| `4` | Failed jobs |
| `5` | Completed jobs |
| `6` | Job schedulers |
| `b` / `n` | Previous / next page of the job list |
| `Enter` | Open job detail |
| `/` | Open search bar (filters by job ID or name) |
| `R` | Retry job (failed jobs only; shown only for Failed) |
| `Shift+A` | Retry all failed jobs in the queue (Failed tab only; confirmation prompt shows the count) |
| `Shift+D` | Delete job (with confirmation prompt) |
| `p` | Promote a delayed job to waiting (shown only for Delayed) |
| `c` | Duplicate job — clones its payload as a new delayed job (with confirmation prompt) |

### Schedulers tab

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate schedulers |
| `←` / `→` / `1`–`6` | Switch tab |
| `b` / `n` | Previous / next page of schedulers |
| `Enter` | Open scheduler detail |
| `Esc` / `h` | Return to the queue list |

The job-only keys (`/`, `R`, `Shift+A`, `Shift+D`, `p`, `c`) do nothing here.

### Scheduler detail

| Key | Action |
|---|---|
| `Enter` | Open the scheduler's next job (when it has one) |
| `Esc` / `h` | Return to the schedulers list |

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

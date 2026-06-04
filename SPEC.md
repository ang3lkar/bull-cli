# bull-cli Specification

A terminal dashboard for [bull](https://github.com/OptimalBits/bull) job queues — the TUI equivalent of bull-board.

---

## Tech Stack

| Concern | Choice |
|---|---|
| Language | TypeScript |
| Runtime | Node.js |
| TUI framework | [Ink](https://github.com/vadimdemedes/ink) (React for terminal) |
| Bull version | `bull` (original) only — BullMQ deferred |
| Distribution | npm global package (`npm install -g bull-cli`) |

---

## Redis Connection

### Discovery

Auto-discovery only. On startup, the CLI connects to Redis and scans for keys matching bull's internal pattern (`bull:*:id`) to infer queue names. No explicit queue configuration required.

### Connection precedence

1. `--redis` CLI flag (highest priority)
2. `REDIS_URL` environment variable
3. `redis://localhost:6379` (default fallback)

### Authentication

Credentials are embedded in the Redis URL — no separate flags.

```
redis://:password@host:6379
redis://username:password@host:6379
```

---

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

### Sidebar

- Lists all discovered bull queues, sorted **alphabetically**
- Shows queue name only — no job counts
- Paused queues show a `⏸` indicator next to their name
- Refreshes every 3 seconds alongside job data

### Status tabs

Five tabs per queue: **Active | Waiting | Completed | Failed | Delayed**

> "Paused" is a queue-level state in bull, not a job status. Paused queues are indicated in the sidebar instead.

### Job list

Consistent columns across all tabs:

| Column | Description |
|---|---|
| ID | Bull job ID (auto-incrementing integer) |
| Name | Job type/name |
| Attempts | Number of attempts made |
| Timestamp | Created at (or processed at for completed jobs) |
| Progress | 0–100 value |

- Sorted **newest first**
- Paginated: **10 jobs per page**
- Page navigation shown in bottom-right of job list panel

### Job detail modal

- Triggered by `Enter` on a selected job
- **Centered modal overlay** over the dashboard
- Shows: full `data` payload (pretty-printed JSON), `returnvalue`, `stacktrace` (failed jobs), all timestamps, `opts`
- Closed with `Escape`

### Footer

Three sections in a single bottom bar:

- **Left:** active Redis connection string (e.g. `redis://localhost:6379`)
- **Center:** `Last updated: Ns ago` (counts up from last refresh)
- **Right:** key hint reminders (`/ search  R refresh  q quit`)

---

## Refresh

- **Auto-refresh:** every **3 seconds**
- **Manual refresh:** `R` key for immediate refresh
- Both queue list and job list refresh together

---

## Search

- Triggered by `/` (vim-style)
- Filters the visible job list by **job ID** or **job name**
- No payload/data search
- `Escape` clears search and returns to full list
- Search resets on queue or tab switch

---

## Keyboard Bindings

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
| `←` / `→` or `1–5` | Switch status tabs |
| `PgUp` / `PgDn` | Paginate job list |
| `Enter` | Open job detail modal |
| `/` | Open search bar |
| `r` | Retry job (failed jobs only) |
| `d` | Delete job |
| `p` | Promote delayed job to waiting |
| `Shift+D` | Drain queue (with confirmation prompt) |

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Redis unreachable | Full-screen error view showing the connection string attempted — no raw stack trace |
| No bull queues found | Empty sidebar with message: `No Bull queues found on redis://localhost:6379` |
| Queue disappears mid-session | Gracefully removed from the sidebar on next refresh |
| Job action fails | Inline toast notification at the bottom of the screen — does not crash |

---

## CLI Interface

```
bull-cli [options]

Options:
  --redis <url>      Redis connection URL (overrides REDIS_URL env var)
  --interval <ms>    Auto-refresh interval in milliseconds (default: 3000)  [future]
  -h, --help         Show help
  -v, --version      Show version
```

---

## Out of Scope (for now)

- BullMQ support
- Multiple Redis instance switching
- Theming / color customization
- Log streaming per job
- Queue metrics / charts

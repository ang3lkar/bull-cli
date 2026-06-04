Now I have everything I need. Let me write the guide — including one important clarification upfront about queue discovery that might not be obvious.

---

## Bull-Board Core Logic Guide

### 1. Queue Discovery

**Bull-board does NOT scan Redis to find queues.** There is no Redis query that lists "all queues". Queues are **explicitly registered** by the application using bull-board, stored in an in-memory `Map<string, BaseAdapter>`:

```typescript
// packages/api/src/queuesApi.ts
const bullBoardQueues = new Map<string, BaseAdapter>();
```

The key is `queue.getName()`, which resolves to `${prefix}${queue.name}` (e.g., `bull:my-queue`). Queues are added via `createBullBoard({ queues: [...] })` or dynamically via `addQueue()` / `removeQueue()` at runtime.

**Implication for building a new UI page:** you get the list of queues from `GET /api/queues`, not from Redis. The response includes all registered queues (subject to visibility guards).

---

### 2. Paused vs. Active Queues

**"Paused" is a per-queue property, not discovered via Redis scan.** Each queue has `isPaused()` called on it individually:

```typescript
// In the queues handler response:
isPaused: await queue.isPaused()
```

This delegates to the underlying library:
- **Bull:** `this.queue.isPaused()` → checks `bull:<name>:paused` key in Redis (a list; if the key exists, the queue is paused)
- **BullMQ:** `this.queue.isPaused()` → checks `bull:<prefix>:<name>:meta` hash field

So from bull-board's perspective, a queue is paused if `GET /api/queues` returns `"isPaused": true` for it. The dashboard shows this per-queue in the response; there's no single "list all paused queues" API endpoint.

**Pausing a queue** — `PUT /api/queues/:queueName/pause`:
```
queueProvider middleware
  └─ checks queue exists, checks NOT readOnly
       └─ calls queue.pause()
            └─ BullAdapter: this.queue.pause()   (Bull library)
               BullMQAdapter: this.queue.pause() (BullMQ library)
```
Returns `200 {}`. Resume is the mirror image via `PUT /api/queues/:queueName/resume`.

---

### 3. Job Counters

**`GET /api/queues` fetches counts for every registered queue**, regardless of which one is selected:

```typescript
// handlers/queues.ts — runs for EVERY visible queue
const counts = await queue.getJobCounts();
// → Bull: queue.getJobCounts()
// → BullMQ: queue.getJobCounts()
```

Both libraries delegate to Redis directly:
- **Bull** uses `LLEN` (for lists: `waiting`, `active`, `paused`) and `ZCARD` (for sorted sets: `delayed`, `failed`, `completed`)
- **BullMQ** does the same but with additional statuses: `waiting-children`, `prioritized`

The returned shape:
```typescript
{
  active: number,
  waiting: number,
  completed: number,
  failed: number,
  delayed: number,
  paused: number,
  // BullMQ also adds:
  "waiting-children": number,
  prioritized: number,
}
```

**Job fetching is lazy** — jobs themselves (not just counts) are only fetched for the queue that is currently selected in the UI. The handler uses the `activeQueue` query param to decide which queue to fetch jobs for, and all others get `jobs: []`.

Pagination range sent to the adapter:
```typescript
start = (page - 1) * jobsPerPage   // e.g. page 1 → 0
end   = start + jobsPerPage - 1    // e.g. jobsPerPage=10 → 9
queue.getJobs(statuses, start, end)
```

---

### 4. Job Lifecycle Operations

#### Creating a job — `POST /api/queues/:queueName/add`

Request body:
```json
{ "name": "job-type", "data": { ...payload }, "options": { "delay": 1000, ... } }
```

Flow:
```
queueProvider → queue.addJob(name, data, options)
                  └─ Bull/BullMQ: queue.add(name, data, options)
```

Returns the formatted job + its initial state.

#### Retrying a job — `PUT /api/queues/:queueName/:jobId/retry`

Only `"failed"` and `"completed"` states are retryable. The current state is fetched first, then passed into `retry()`:

```
queueProvider
  └─ jobProvider (fetches job via queue.getJob(jobId))
       └─ job.getState()            ← checks current state in Redis
            └─ if 'failed' or 'completed':
                 job.retry(state)   ← moves job back to waiting list
```

Returns `204` on success, `400` with an error message if the job is in a non-retryable state (e.g., `"active"`, `"delayed"`).

**Note on Bull vs. BullMQ attempt counts:** BullAdapter adds `+1` to `attemptsMade` when returning job data (`alignJobData()`) to match BullMQ's counting convention. This is purely cosmetic for display.

---

### 5. Full API Surface (what you can build a page on top of)

| Endpoint                                     | What it returns / does                                    |
| -------------------------------------------- | --------------------------------------------------------- |
| `GET /api/queues`                            | All queues with counts, pagination, jobs for active queue |
| `GET /api/queues/:name/:jobId`               | Single job details + state                                |
| `GET /api/queues/:name/:jobId/logs`          | Job log lines                                             |
| `GET /api/queues/:name/:jobId/flow`          | Parent/child job tree (BullMQ only)                       |
| `POST /api/queues/:name/add`                 | Add a new job                                             |
| `PUT /api/queues/:name/pause`                | Pause queue                                               |
| `PUT /api/queues/:name/resume`               | Resume queue                                              |
| `PUT /api/queues/:name/empty`                | Drain waiting jobs                                        |
| `PUT /api/queues/:name/obliterate`           | Destroy queue entirely (must be paused first)             |
| `PUT /api/queues/:name/promote`              | Promote all delayed jobs                                  |
| `PUT /api/queues/:name/retry/:status`        | Retry all jobs in a status bucket                         |
| `PUT /api/queues/:name/clean/:status`        | Remove all jobs in a status (with 5s grace)               |
| `PUT /api/queues/:name/:jobId/retry`         | Retry one job                                             |
| `PUT /api/queues/:name/:jobId/promote`       | Promote one delayed job                                   |
| `PUT /api/queues/:name/:jobId/clean`         | Remove one job                                            |
| `PATCH /api/queues/:name/:jobId/update-data` | Update job payload                                        |
| `PUT /api/queues/:name/concurrency`          | Set global concurrency (BullMQ)                           |
| `GET /api/redis/stats`                       | Redis server info (memory, version, etc.)                 |

---

### Key invariant to keep in mind

The queue list is **static by default** — bull-board has no polling or pub/sub to detect new queues in Redis. If you need the list to update dynamically, the server must call `addQueue()` / `removeQueue()` and your UI must re-fetch `GET /api/queues`. Job counts and states do update on every `GET /api/queues` call since they hit Redis each time.

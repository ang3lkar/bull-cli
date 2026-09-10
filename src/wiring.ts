import type { Queue } from 'bullmq';
import clipboard from 'clipboardy';
import { connectionFromUrl } from './config.js';
import {
  deleteJob,
  drainQueue,
  duplicateJob,
  promoteJob,
  retryJob,
  togglePauseQueue,
} from './core/actions.js';
import { discoverQueues } from './core/discovery.js';
import { fetchJobPage, fetchQueueCounts, getJobDetail } from './core/jobs.js';
import { createQueueRegistry, type QueueRegistry } from './core/queueRegistry.js';
import { createRedisClient } from './core/redis.js';
import { DashboardStore, type StoreDeps } from './core/store.js';
import type { ActionResult } from './core/types.js';

export interface WiredApp {
  store: DashboardStore;
  /**
   * Attempts the initial Redis connection and kicks off the first
   * `refresh()` + 3s polling loop. The store does NOT refresh on
   * construction (Phase 6) — without this, the dashboard would start (and
   * stay) empty. `connect()` rejecting on the first failed attempt is NOT
   * treated as fatal here: the redis client's `onStatus` callback (wired
   * below) has already surfaced it as a connection error via
   * `store.onConnectionStatus`, and `refresh()` is called regardless so the
   * store's own bounded refresh-timeout takes over if Redis stays
   * unreachable, exactly per the connection contract.
   */
  start(): Promise<void>;
  /** Stops polling, closes cached bullmq `Queue`s, and disconnects ioredis — call on quit so the process doesn't hang. */
  stop(): Promise<void>;
}

/**
 * `registry.getQueue(name)` calls bullmq's `Queue` constructor, which
 * throws SYNCHRONOUSLY for a name bullmq itself would never produce (most
 * notably one containing `:` — bullmq 5.x rejects it outright). Such a name
 * can still exist in Redis (written by an older bullmq version or another
 * client — see `discovery.ts`'s colon-name handling), so `discoverQueues`
 * happily reports it and the sidebar lists it, but it can never actually be
 * *opened*. Every dep below that touches a queue name goes through one of
 * these two guards so that synchronous throw is normalized into whatever
 * shape the call site already expects, instead of escaping uncaught (a
 * `void store.someMethod()` call from `useKeymap` turns an uncaught
 * exception here into an unhandled promise rejection):
 * - `fetchJobPage`/`getJobDetail`: normalized into a REJECTED promise —
 *   `DashboardStore.doRefreshWork`'s per-queue try/catch and `openDetail`'s
 *   own try/catch already handle that uniformly (toast, no crash).
 * - actions (`retry`/`delete`/`promote`/`duplicate`/`togglePause`/`drain`):
 *   normalized
 *   into `{ ok: false, message }` — the ONLY shape `DashboardStore`'s action
 *   dispatch (`runJobAction`/`togglePauseSelectedQueue`) ever expects; it
 *   has no try/catch of its own because `actions.ts` itself guarantees it
 *   never throws, so this is what keeps that guarantee true even when the
 *   queue can't be opened at all.
 */
async function safeFetch<T>(
  registry: QueueRegistry,
  queueName: string,
  run: (queue: Queue) => Promise<T>,
): Promise<T> {
  // Deliberately `async`, not a plain arrow returning `run(...)` directly:
  // `registry.getQueue`'s synchronous throw must be converted into this
  // function's own promise rejection (the `async` keyword is what does
  // that conversion) rather than escaping synchronously to the caller.
  const queue = registry.getQueue(queueName);
  return run(queue);
}

async function safeAction(
  registry: QueueRegistry,
  queueName: string,
  run: (queue: Queue) => Promise<ActionResult>,
): Promise<ActionResult> {
  let queue: Queue;
  try {
    queue = registry.getQueue(queueName);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  return run(queue);
}

/**
 * Wires the framework-agnostic `DashboardStore` to real `ioredis`/`bullmq`
 * adapters (`discovery.ts`, `jobs.ts`, `actions.ts`, `queueRegistry.ts`).
 * Deliberately thin glue — no behavior lives here beyond adapting function
 * signatures (plus the `safeFetch`/`safeAction` guards above); it's
 * exercised end-to-end by the Phase 9 e2e tests rather than unit-tested in
 * isolation.
 */
export function createApp(
  redisUrl: string,
  prefix: string,
  pollIntervalMs?: number,
  refreshTimeoutMs?: number,
): WiredApp {
  const registry = createQueueRegistry(connectionFromUrl(redisUrl), prefix);

  const redis = createRedisClient(redisUrl, (status) => {
    store.onConnectionStatus(status);
  });

  const deps: StoreDeps = {
    discoverQueues: () => discoverQueues(redis, prefix),
    fetchJobPage: (queueName, status, page) =>
      safeFetch(registry, queueName, (queue) => fetchJobPage(queue, status, page)),
    fetchQueueCounts: (queueName) =>
      safeFetch(registry, queueName, (queue) => fetchQueueCounts(queue)),
    getJobDetail: (queueName, jobId) =>
      safeFetch(registry, queueName, (queue) => getJobDetail(queue, jobId)),
    copyToClipboard: (text) => clipboard.write(text),
    actions: {
      retry: (queueName, jobId) =>
        safeAction(registry, queueName, (queue) => retryJob(queue, jobId)),
      delete: (queueName, jobId) =>
        safeAction(registry, queueName, (queue) => deleteJob(queue, jobId)),
      promote: (queueName, jobId) =>
        safeAction(registry, queueName, (queue) => promoteJob(queue, jobId)),
      duplicate: (queueName, jobId) =>
        safeAction(registry, queueName, (queue) => duplicateJob(queue, jobId)),
      togglePause: (queueName) =>
        safeAction(registry, queueName, (queue) => togglePauseQueue(queue)),
      drain: (queueName) => safeAction(registry, queueName, (queue) => drainQueue(queue)),
    },
    syncRegistry: (names) => registry.sync(names),
  };

  const store = new DashboardStore(deps, { redisUrl, pollIntervalMs, refreshTimeoutMs });

  async function start(): Promise<void> {
    await redis.connect().catch(() => {
      // Non-terminal: the 'error' event (always attached in `createRedisClient`)
      // has already reported this via `onConnectionStatus`, and background
      // reconnection keeps running per the connection contract.
    });
    await store.refresh();
    store.startPolling();
  }

  async function stop(): Promise<void> {
    store.dispose();
    await registry.closeAll();
    redis.disconnect();
  }

  return { store, start, stop };
}

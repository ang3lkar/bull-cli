import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionOpts } from '../../src/config.js';
import { createApp, type WiredApp } from '../../src/wiring.js';
import { addWaiting } from './helpers/seed.js';

/**
 * Regression coverage for the colon-named-queue crash: `discovery.ts`
 * (correctly) reports queue names bullmq's own `Queue` constructor can
 * never open (e.g. `billing:invoices`, a name that can only exist in Redis
 * via an older bullmq version or another client — see
 * `discovery.test.ts`'s equivalent case). Before the fix, such a queue
 * sorting first alphabetically and auto-selecting on startup bricked the
 * ENTIRE dashboard into a fatal full-screen connection error. This suite
 * drives the real, fully-wired `createApp()` (not fakes) against a
 * dedicated Redis DB to prove the crash is gone at the wiring boundary.
 *
 * Like the Phase 9 e2e suite, assertions poll (`vi.waitFor`) rather than
 * checking state immediately after `app.start()` resolves: `start()`'s
 * `connect()` can trigger its own coalesced `onConnectionStatus`-driven
 * refresh racing with `start()`'s own explicit one (same real-world
 * asynchrony `tests/e2e/helpers.ts`'s `waitForFrame`/`waitForSnapshot`
 * exist to handle), so `start()` resolving doesn't guarantee a refresh has
 * fully landed yet.
 */
const WIRING_DB = 5;
const REDIS_URL = `redis://localhost:6379/${WIRING_DB}`;
const connection: ConnectionOpts = { host: 'localhost', port: 6379, db: WIRING_DB };
const WAIT_TIMEOUT_MS = 5000;

let redis: Redis;
let app: WiredApp | undefined;
let verifyQueue: Queue | undefined;

beforeAll(() => {
  redis = new Redis({ ...connection, maxRetriesPerRequest: null });
});

beforeEach(async () => {
  await redis.flushdb();
  app = undefined;
  verifyQueue = undefined;
});

afterEach(async () => {
  await app?.stop();
  await verifyQueue?.close();
});

afterAll(() => {
  redis.disconnect();
});

function snapshot() {
  if (!app) {
    throw new Error('app not started');
  }
  return app.store.getSnapshot();
}

describe('createApp: a colon-named queue does not take down the dashboard', () => {
  it('starts, lists both queues, auto-selects the colon-named one with an empty/toasted job list, and recovers on switch', async () => {
    // Raw hset, exactly like `discovery.test.ts`'s equivalent case — a
    // colon-containing queue name can only enter Redis this way, never via
    // bullmq's own `Queue` constructor (which rejects it outright).
    await redis.hset('bull:billing:invoices:meta', 'opts.maxLenEvents', '10000');

    const emailQueue = new Queue('emailQ', { connection });
    verifyQueue = emailQueue;
    await emailQueue.waitUntilReady();
    await addWaiting(emailQueue, 2, 'wjob');
    await vi.waitUntil(async () => (await redis.exists('bull:emailQ:meta')) === 1, {
      timeout: WAIT_TIMEOUT_MS,
    });

    app = createApp(REDIS_URL);
    await app.start();

    // 'billing:invoices' sorts before 'emailQ' alphabetically -> auto-selected.
    await vi.waitFor(
      () => {
        expect(snapshot().queues.map((q) => q.name)).toEqual(['billing:invoices', 'emailQ']);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
    const afterStart = snapshot();
    expect(afterStart.connection).toEqual({ state: 'ready' });
    expect(afterStart.selectedQueueName).toBe('billing:invoices');
    expect(afterStart.jobPage).toBeNull();
    expect(afterStart.toasts).toHaveLength(1);
    expect(afterStart.toasts[0].message).toContain('billing:invoices');
    expect(afterStart.toasts[0].message).toContain('cannot contain');

    // The dashboard stays fully navigable: switching to the normal queue
    // works and shows its real jobs. `addWaiting` seeds `waiting` jobs, not
    // `active` (the default tab), so switch tabs too.
    app.store.selectQueue('emailQ');
    app.store.selectTab('waiting');
    await vi.waitFor(
      () => {
        expect(snapshot().jobPage?.jobs).toHaveLength(2);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
    const afterSwitch = snapshot();
    expect(afterSwitch.connection).toEqual({ state: 'ready' });
    expect(afterSwitch.jobPage?.totalCount).toBe(2);

    // Switching back to the still-broken queue toasts again (fresh failure
    // after a successful fetch resets the dedupe tracking) ...
    app.store.selectQueue('billing:invoices');
    await vi.waitFor(
      () => {
        expect(snapshot().toasts).toHaveLength(2);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
    expect(snapshot().jobPage).toBeNull();

    // ... but a further refresh against the SAME still-broken queue does
    // not add a third toast (poll-tick dedupe).
    await app.store.refresh();
    expect(snapshot().toasts).toHaveLength(2);
  }, 15000);

  it('a queue-level action (pause) on the colon-named queue resolves to a toast, never an unhandled rejection', async () => {
    await redis.hset('bull:billing:invoices:meta', 'opts.maxLenEvents', '10000');

    app = createApp(REDIS_URL);
    await app.start();
    await vi.waitFor(
      () => {
        expect(snapshot().selectedQueueName).toBe('billing:invoices');
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    await expect(app.store.togglePauseSelectedQueue()).resolves.toBeUndefined();
    const messages = snapshot().toasts.map((t) => t.message.toLowerCase());
    expect(messages.some((m) => m.includes('cannot contain'))).toBe(true);
  });
});

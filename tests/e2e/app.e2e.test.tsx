import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addWaiting, closeSeeded, makeCompleted } from '../integration/helpers/seed.js';
import {
  CONNECTION,
  KEY,
  type MountedApp,
  mountApp,
  pressAndWaitForFrame,
  REDIS_URL,
  UNREACHABLE_REDIS_URL,
  unmountApp,
  waitForFrame,
  waitForSnapshot,
} from './helpers.js';

/**
 * Full-app e2e suite (Phase 9): `createApp()` wired against a real,
 * dedicated Redis DB (db 4), rendered through `ink-testing-library`. Real
 * timers throughout — the store's 3s auto-refresh runs for real, so every
 * assertion polls (`waitForFrame`/`waitForSnapshot`) rather than asserting
 * immediately. See `tests/e2e/helpers.ts` for the shared mount/cleanup/poll
 * plumbing.
 */

let redis: Redis;
let mounted: MountedApp | undefined;
let queues: Queue[];

beforeAll(() => {
  redis = new Redis({ ...CONNECTION, maxRetriesPerRequest: null });
});

beforeEach(async () => {
  await redis.flushdb();
  mounted = undefined;
  queues = [];
});

afterEach(async () => {
  // Both cleanup steps run unconditionally, even if the test body threw an
  // assertion error above — vitest still runs `afterEach` — so no scenario
  // can leak a poll timer, an open ioredis connection, or a bullmq `Queue`.
  await unmountApp(mounted);
  await Promise.all(queues.map((q) => q.close()));
});

afterAll(() => {
  redis.disconnect();
});

/** Creates (and tracks for `afterEach` cleanup) a plain seeding/verification `Queue` against the e2e DB. */
function trackedQueue(name: string): Queue {
  const queue = new Queue(name, { connection: CONNECTION });
  queues.push(queue);
  return queue;
}

describe('Browse: sidebar, tabs, and job list', () => {
  it('shows discovered queues alphabetically with a pause indicator, tabs, and the waiting job list', async () => {
    const alpha = trackedQueue('alpha');
    await addWaiting(alpha, 3, 'alpha-job');
    const beta = trackedQueue('beta');
    await addWaiting(beta, 1, 'beta-job');
    await beta.pause();

    mounted = await mountApp(REDIS_URL);

    // Initial data lands slightly after start() resolves (the 'ready'
    // connection event triggers its own coalesced refresh) — poll rather
    // than asserting immediately.
    let frame = await waitForFrame(
      mounted.lastFrame,
      (f) => f.includes('alpha') && f.includes('beta'),
    );

    // Alphabetical order: "alpha" renders before "beta" in the sidebar.
    expect(frame.indexOf('alpha')).toBeLessThan(frame.indexOf('beta'));
    // Paused indicator next to beta.
    expect(frame).toContain('beta ⏸');
    // Default tab is Active (per store's TAB_ORDER); alpha (auto-selected,
    // first alphabetically) has no active jobs.
    expect(frame).toContain('[Active]');
    expect(frame).toContain('No jobs');

    // Focus the job list (sidebar's own marker switches from ❯ to · once
    // focus moves away — a previously-absent string, so this can't pass
    // "by accident" off a stale frame), then switch to the Waiting tab.
    frame = await pressAndWaitForFrame(mounted, KEY.tab, (f) => f.includes('· alpha'));
    frame = await pressAndWaitForFrame(
      mounted,
      '2',
      (f) => f.includes('[Waiting]') && f.includes('alpha-job-2'),
    );

    // Newest-first: alpha-job-2 was added last, so it's the top (selected) row.
    expect(frame).toContain('alpha-job-2');
    expect(frame).toContain('alpha-job-1');
    expect(frame).toContain('alpha-job-0');
    expect(frame).toContain('Page 1 of 1');

    // Footer: URL (no auth on this URL, so it's shown verbatim) + ticking clock.
    expect(frame).toContain(REDIS_URL);
    expect(frame).toContain('Last updated:');
  });
});

describe('Detail modal', () => {
  it('shows pretty-printed data + returnvalue for a completed job; Escape closes it', async () => {
    const queueName = 'detailQ';
    const completedSeed = await makeCompleted(queueName, CONNECTION, 1, {
      outcome: 'ok',
      score: 42,
    });
    // Stop the worker immediately (it's already done its one job) so it
    // can't interfere further; keep the queue open, tracked for cleanup.
    await closeSeeded({ worker: completedSeed.worker });
    queues.push(completedSeed.queue);

    mounted = await mountApp(REDIS_URL);
    await waitForFrame(mounted.lastFrame, (f) => f.includes(queueName));

    // Sidebar's own marker flips from ❯ to · once focus moves to the job
    // list — a previously-absent string, so waiting for it rules out
    // dispatching the next key against a stale, pre-toggle frame/snapshot.
    await pressAndWaitForFrame(mounted, KEY.tab, (f) => f.includes(`· ${queueName}`));
    let frame = await pressAndWaitForFrame(
      mounted,
      '3',
      (f) => f.includes('[Completed]') && f.includes('job-0'),
    );
    expect(frame).toContain('job-0');

    frame = await pressAndWaitForFrame(mounted, KEY.enter, (f) => f.includes('Return Value'));
    // makeCompleted's job data payload is `{ i: 0 }` (see seed.ts).
    expect(frame).toContain('"i": 0');
    expect(frame).toContain('"outcome": "ok"');
    expect(frame).toContain('"score": 42');

    frame = await pressAndWaitForFrame(mounted, KEY.esc, (f) => f.includes('Page 1 of'));
    expect(frame).not.toContain('Return Value');
  });
});

describe('Action verified in Redis: delete', () => {
  it('deleting the selected waiting job removes it from both the frame and Redis', async () => {
    const queue = trackedQueue('deleteQ');
    await addWaiting(queue, 2, 'wjob');

    mounted = await mountApp(REDIS_URL);
    await waitForFrame(mounted.lastFrame, (f) => f.includes('deleteQ'));

    await pressAndWaitForFrame(mounted, KEY.tab, (f) => f.includes('· deleteQ'));
    await pressAndWaitForFrame(
      mounted,
      '2',
      (f) => f.includes('[Waiting]') && f.includes('wjob-1'),
    );

    const snapshotBeforeDelete = await waitForSnapshot(
      mounted.app.store,
      (s) => s.selectedJobId !== null,
    );
    const deletedId = snapshotBeforeDelete.selectedJobId;
    expect(deletedId).not.toBeNull();

    const frame = await pressAndWaitForFrame(
      mounted,
      'd',
      (f) => (f.match(/wjob-\d/g) ?? []).length === 1,
    );
    expect((frame.match(/wjob-\d/g) ?? []).length).toBe(1);
    expect(frame).toContain('Page 1 of 1');

    // Verify against Redis directly, via a fresh bullmq Queue instance.
    const verifyQueue = trackedQueue('deleteQ');
    await expect(verifyQueue.getJob(deletedId as string)).resolves.toBeUndefined();
    const counts = await verifyQueue.getJobCounts('waiting');
    expect(counts.waiting).toBe(1);
  });
});

describe('Action verified in Redis: pause', () => {
  it('pausing the selected queue shows the indicator and pauses it in Redis', async () => {
    const queue = trackedQueue('pauseQ');
    await addWaiting(queue, 1, 'wjob');

    mounted = await mountApp(REDIS_URL);
    await waitForFrame(mounted.lastFrame, (f) => f.includes('pauseQ'));
    expect(mounted.lastFrame() ?? '').not.toContain('pauseQ ⏸');

    // Sidebar is focused by default; the only queue is auto-selected.
    const frame = await pressAndWaitForFrame(mounted, 'p', (f) => f.includes('pauseQ ⏸'));
    expect(frame).toContain('pauseQ ⏸');

    const verifyQueue = trackedQueue('pauseQ');
    await expect(verifyQueue.isPaused()).resolves.toBe(true);
  });
});

describe('Colon-named queue does not brick the dashboard', () => {
  it('renders sidebar + tabs with a toast for an un-openable queue, and arrow-down reaches a normal one', async () => {
    // A colon-containing queue name can only enter Redis via a raw key
    // write (an older bullmq version or another client) — bullmq's own
    // `Queue` constructor rejects it outright. `discovery.ts` still reports
    // it (see `discovery.test.ts`'s equivalent case), and it sorts BEFORE
    // "zzzQ" alphabetically, so it's auto-selected on startup — exactly the
    // shape that used to brick the whole dashboard into a fatal
    // full-screen error before this fix.
    await redis.hset('bull:billing:invoices:meta', 'opts.maxLenEvents', '10000');
    const normalQueue = trackedQueue('zzzQ');
    await addWaiting(normalQueue, 1, 'wjob');

    mounted = await mountApp(REDIS_URL);

    // The dashboard renders fully (sidebar + tabs), not a full-screen error.
    let frame = await waitForFrame(
      mounted.lastFrame,
      (f) => f.includes('billing:invoices') && f.includes('zzzQ'),
    );
    expect(frame).toContain('[Active]');
    expect(frame).not.toContain('Cannot connect to Redis');
    // Auto-selected (sorts first) and focused by default.
    expect(frame).toContain('❯ billing:invoices');
    expect(frame).toContain('No jobs');
    expect(frame).toContain('cannot contain');

    // Arrow-down (sidebar focused by default) moves off the broken queue to
    // the normal one, which shows its real waiting job once its tab is
    // selected — proving the dashboard stays fully navigable.
    frame = await pressAndWaitForFrame(mounted, KEY.down, (f) => f.includes('❯ zzzQ'));
    frame = await pressAndWaitForFrame(
      mounted,
      KEY.tab,
      (f) => f.includes('· zzzQ'), // focus moved to the job list
    );
    frame = await pressAndWaitForFrame(
      mounted,
      '2',
      (f) => f.includes('[Waiting]') && f.includes('wjob-0'),
    );
    expect(frame).toContain('wjob-0');
    expect(frame).toContain('Page 1 of 1');
  });
});

describe('Error screen', () => {
  it('shows a full-screen connection error (no stack trace) when Redis is unreachable', async () => {
    mounted = await mountApp(UNREACHABLE_REDIS_URL);

    // Runtime here depends on the store's refreshTimeoutMs (default 5000ms,
    // see core/store.ts) staying well below this suite's 20s testTimeout.
    const frame = await waitForFrame(
      mounted.lastFrame,
      (f) => f.includes('Cannot connect to Redis'),
      15000,
    );

    expect(frame).toContain('localhost:9999');
    expect(frame).not.toContain(' at ');

    // stop() must cleanly halt the redis client's forever-retry loop.
    await unmountApp(mounted);
    mounted = undefined;
  }, 20000);
});

describe('Live refresh', () => {
  it('picks up a job added externally within a couple of poll intervals', async () => {
    const queue = trackedQueue('liveQ');
    await addWaiting(queue, 1, 'wjob');

    mounted = await mountApp(REDIS_URL);
    await waitForFrame(mounted.lastFrame, (f) => f.includes('liveQ'));

    await pressAndWaitForFrame(mounted, KEY.tab, (f) => f.includes('· liveQ'));
    let frame = await pressAndWaitForFrame(
      mounted,
      '2',
      (f) => f.includes('[Waiting]') && f.includes('wjob-0') && f.includes('Page 1 of 1'),
    );
    expect(frame).toContain('Page 1 of 1');

    // Add a second job externally, bypassing the app under test entirely.
    await addWaiting(queue, 1, 'wjob-extra');

    // Bounded wait: at most ~2 polling intervals (3s each) plus CI slack,
    // still well under the outer 15s test timeout.
    frame = await waitForFrame(mounted.lastFrame, (f) => f.includes('wjob-extra-0'), 10000);
    expect(frame).toContain('wjob-0');
    expect(frame).toContain('wjob-extra-0');
  }, 15000);
});

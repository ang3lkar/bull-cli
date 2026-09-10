import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardStore, type StoreDeps } from '../../src/core/store.js';
import type {
  ActionResult,
  JobDetail,
  JobPage,
  JobStatus,
  JobSummary,
  QueueInfo,
} from '../../src/core/types.js';

// --- fixtures & fakes ------------------------------------------------

function makeQueue(name: string, isPaused = false): QueueInfo {
  return { name, isPaused };
}

function makeJob(id: string, name: string, overrides: Partial<JobSummary> = {}): JobSummary {
  return { id, name, attemptsMade: 0, timestamp: 0, progress: null, ...overrides };
}

const ALL_STATUSES: JobStatus[] = ['active', 'waiting', 'completed', 'failed', 'delayed'];

const ZERO_COUNTS: Record<JobStatus, number> = {
  active: 0,
  waiting: 0,
  completed: 0,
  failed: 0,
  delayed: 0,
};

function paginate(jobs: JobSummary[], page: number): JobPage {
  const pageCount = Math.max(1, Math.ceil(jobs.length / 10));
  const clamped = Math.min(Math.max(page, 0), pageCount - 1);
  const slice = jobs.slice(clamped * 10, clamped * 10 + 10);
  return { jobs: slice, totalCount: jobs.length, page: clamped, pageCount, counts: ZERO_COUNTS };
}

interface FakeState {
  queues: QueueInfo[];
  /** keyed by `${queueName}::${status}` */
  jobs: Record<string, JobSummary[]>;
  /** keyed by `${queueName}::${jobId}` */
  details: Record<string, JobDetail>;
}

function jobKey(queueName: string, status: JobStatus): string {
  return `${queueName}::${status}`;
}

function detailKey(queueName: string, jobId: string): string {
  return `${queueName}::${jobId}`;
}

function countsForQueue(state: FakeState, queueName: string): Record<JobStatus, number> {
  return Object.fromEntries(
    ALL_STATUSES.map((s) => [s, state.jobs[jobKey(queueName, s)]?.length ?? 0]),
  ) as Record<JobStatus, number>;
}

function createFakeDeps(state: FakeState): StoreDeps {
  return {
    discoverQueues: vi.fn(async () => state.queues),
    // Present in the real wiring for every discovered queue (`wiring.ts`),
    // which is what lets a queue's counts be known before it's ever
    // entered — the fake must match, or the tabCounts tests below run in a
    // configuration production never produces.
    fetchQueueCounts: vi.fn(async (queueName: string) => countsForQueue(state, queueName)),
    fetchJobPage: vi.fn(async (queueName: string, status: JobStatus, page: number) => ({
      ...paginate(state.jobs[jobKey(queueName, status)] ?? [], page),
      counts: countsForQueue(state, queueName),
    })),
    getJobDetail: vi.fn(async (queueName: string, jobId: string) => {
      return state.details[detailKey(queueName, jobId)] ?? null;
    }),
    actions: {
      retry: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
      delete: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
      promote: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
      duplicate: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
      togglePause: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
      drain: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
    },
    syncRegistry: vi.fn(async () => {}),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

const activeStores: DashboardStore[] = [];

function track(store: DashboardStore): DashboardStore {
  activeStores.push(store);
  return store;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const store of activeStores.splice(0)) {
    store.dispose();
  }
  vi.useRealTimers();
});

// --- tests -------------------------------------------------------------

describe('DashboardStore: refresh', () => {
  it('populates queues, jobs, and lastUpdatedAt', async () => {
    const state: FakeState = {
      queues: [makeQueue('emailQ'), makeQueue('smsQ')],
      jobs: { [jobKey('emailQ', 'active')]: [makeJob('1', 'send-email')] },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://localhost:6379' }));

    expect(store.getSnapshot().lastUpdatedAt).toBeNull();
    await store.refresh();

    const snap = store.getSnapshot();
    expect(snap.queues).toEqual(state.queues);
    expect(snap.selectedQueueName).toBe('emailQ');
    expect(snap.jobPage?.jobs).toEqual([makeJob('1', 'send-email')]);
    expect(snap.selectedJobId).toBe('1');
    expect(snap.lastUpdatedAt).not.toBeNull();
    expect(snap.connection).toEqual({ state: 'ready' });
    expect(snap.refreshing).toBe(false);
  });

  it('handles zero discovered queues without crashing', async () => {
    const state: FakeState = { queues: [], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    await store.refresh();
    const snap = store.getSnapshot();
    expect(snap.selectedQueueName).toBeNull();
    expect(snap.jobPage).toBeNull();
    expect(snap.selectedJobId).toBeNull();
  });

  it('preserves the selected queue by name and selected job by id across refresh', async () => {
    const state: FakeState = {
      queues: [makeQueue('a'), makeQueue('b'), makeQueue('c')],
      jobs: { [jobKey('b', 'active')]: [makeJob('1', 'j1'), makeJob('2', 'j2')] },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    await store.refresh();
    store.selectQueue('b');
    await flush();
    store.selectNextJob();
    expect(store.getSnapshot().selectedJobId).toBe('2');

    await store.refresh();
    const snap = store.getSnapshot();
    expect(snap.selectedQueueName).toBe('b');
    expect(snap.selectedJobId).toBe('2');
  });

  it('clamps to the nearest remaining queue when the selected queue vanishes', async () => {
    const state: FakeState = {
      queues: [makeQueue('a'), makeQueue('b'), makeQueue('c')],
      jobs: {},
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    await store.refresh();
    store.selectQueue('b');
    await flush();
    expect(store.getSnapshot().selectedQueueName).toBe('b');

    state.queues = [makeQueue('a'), makeQueue('c')];
    await store.refresh();
    // old index of 'b' was 1; nearest remaining at index 1 is 'c'
    expect(store.getSnapshot().selectedQueueName).toBe('c');
  });

  it('clamps selectedQueueName to null when all queues disappear', async () => {
    const state: FakeState = { queues: [makeQueue('a')], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    await store.refresh();
    expect(store.getSnapshot().selectedQueueName).toBe('a');

    state.queues = [];
    await store.refresh();
    const snap = store.getSnapshot();
    expect(snap.selectedQueueName).toBeNull();
    expect(snap.jobPage).toBeNull();
    expect(snap.selectedJobId).toBeNull();
    expect(snap.tabCounts).toBeNull();
  });

  it('clamps selectedJobId to the nearest remaining job when it vanishes mid-list', async () => {
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: {
        [jobKey('a', 'active')]: [makeJob('1', 'j1'), makeJob('2', 'j2'), makeJob('3', 'j3')],
      },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    await store.refresh();
    store.selectNextJob(); // -> '2' (index 1)
    expect(store.getSnapshot().selectedJobId).toBe('2');

    state.jobs[jobKey('a', 'active')] = [makeJob('1', 'j1'), makeJob('3', 'j3')];
    await store.refresh();
    // old index of '2' was 1; nearest remaining at index 1 is '3'
    expect(store.getSnapshot().selectedJobId).toBe('3');
  });

  it('discards a late-resolving discoverQueues result after a timeout bump', async () => {
    const state: FakeState = { queues: [], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    const { promise, resolve } = deferred<QueueInfo[]>();
    (deps.discoverQueues as ReturnType<typeof vi.fn>).mockReturnValueOnce(promise);

    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x', refreshTimeoutMs: 50 }));
    const p = store.refresh();
    await vi.advanceTimersByTimeAsync(50);
    await p;
    expect(store.getSnapshot().connection.state).toBe('error');

    resolve([makeQueue('late')]);
    await flush();
    expect(store.getSnapshot().queues).toEqual([]);
  });

  it('discards a late-resolving syncRegistry result after a timeout bump', async () => {
    const state: FakeState = { queues: [makeQueue('a')], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    const { promise, resolve } = deferred<void>();
    (deps.syncRegistry as ReturnType<typeof vi.fn>).mockReturnValueOnce(promise);

    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x', refreshTimeoutMs: 50 }));
    const p = store.refresh();
    await vi.advanceTimersByTimeAsync(50);
    await p;
    const afterTimeout = store.getSnapshot();
    expect(afterTimeout.connection.state).toBe('error');
    // `discoverQueues()` itself resolved fine (only `syncRegistry` hung) —
    // per the failure-domain split, `queues`/`selectedQueueName` commit as
    // soon as discovery succeeds and are NOT rolled back by a later
    // per-queue-domain timeout; only the not-yet-reached job-fetch state
    // (`jobPage`/`lastUpdatedAt`) stays unset.
    expect(afterTimeout.queues).toEqual(state.queues);
    expect(afterTimeout.selectedQueueName).toBe('a');
    expect(afterTimeout.jobPage).toBeNull();
    expect(afterTimeout.lastUpdatedAt).toBeNull();

    resolve();
    await flush();
    const afterLateResolve = store.getSnapshot();
    expect(afterLateResolve.jobPage).toBeNull();
    expect(afterLateResolve.connection.state).toBe('error');
    expect(afterLateResolve.lastUpdatedAt).toBeNull();
  });

  it('discards a late-resolving fetchJobPage result after a timeout bump', async () => {
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: { [jobKey('a', 'active')]: [makeJob('1', 'j1')] },
      details: {},
    };
    const deps = createFakeDeps(state);
    const { promise, resolve } = deferred<JobPage>();
    (deps.fetchJobPage as ReturnType<typeof vi.fn>).mockReturnValueOnce(promise);

    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x', refreshTimeoutMs: 50 }));
    const p = store.refresh();
    await vi.advanceTimersByTimeAsync(50);
    await p;
    const afterTimeout = store.getSnapshot();
    expect(afterTimeout.connection.state).toBe('error');
    expect(afterTimeout.jobPage).toBeNull();
    expect(afterTimeout.lastUpdatedAt).toBeNull();

    resolve(paginate(state.jobs[jobKey('a', 'active')], 0));
    await flush();
    const afterLateResolve = store.getSnapshot();
    expect(afterLateResolve.jobPage).toBeNull();
    expect(afterLateResolve.connection.state).toBe('error');
    expect(afterLateResolve.lastUpdatedAt).toBeNull();
  });

  it('sets refreshing false and surfaces an error after the refresh timeout bound (fetchJobPage hangs forever)', async () => {
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: { [jobKey('a', 'active')]: [makeJob('1', 'j1')] },
      details: {},
    };
    const deps = createFakeDeps(state);
    (deps.fetchJobPage as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise(() => {}));

    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x', refreshTimeoutMs: 50 }));
    const p = store.refresh();
    await vi.advanceTimersByTimeAsync(50);
    await p;

    const snap = store.getSnapshot();
    expect(snap.refreshing).toBe(false);
    expect(snap.connection).toEqual({
      state: 'error',
      url: 'redis://x',
      message:
        'Refresh timed out after 50ms — Redis may be unreachable, or slow enough to need a larger "refreshTimeoutMs" in your bull-cli config',
    });
  });

  it('surfaces a thrown Error from a dep as a connection error', async () => {
    const state: FakeState = { queues: [], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    (deps.discoverQueues as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('kaboom'));

    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    expect(store.getSnapshot().connection).toEqual({
      state: 'error',
      url: 'redis://x',
      message: 'kaboom',
    });
    expect(store.getSnapshot().refreshing).toBe(false);
  });

  it('stringifies a non-Error rejection from a dep', async () => {
    const state: FakeState = { queues: [], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    (deps.discoverQueues as ReturnType<typeof vi.fn>).mockRejectedValueOnce('plain-string-error');

    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    expect(store.getSnapshot().connection).toEqual({
      state: 'error',
      url: 'redis://x',
      message: 'plain-string-error',
    });
  });

  it('coalesces concurrent refresh() calls into exactly one trailing refresh', async () => {
    const state: FakeState = { queues: [makeQueue('a')], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    const p1 = store.refresh();
    const p2 = store.refresh();
    const p3 = store.refresh();
    await Promise.all([p1, p2, p3]);

    // Exactly one extra (trailing) run beyond the first in-flight one.
    expect(deps.discoverQueues).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().refreshing).toBe(false);
  });
});

describe('DashboardStore: tabCounts', () => {
  it('is null before anything has loaded', () => {
    const deps = createFakeDeps({ queues: [], jobs: {}, details: {} });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    expect(store.getSnapshot().tabCounts).toBeNull();
  });

  it('reflects the per-status job counts for the selected queue and updates when switching queues', async () => {
    const state: FakeState = {
      queues: [makeQueue('a'), makeQueue('b')],
      jobs: {
        [jobKey('a', 'active')]: [makeJob('a1', 'j1'), makeJob('a2', 'j2')],
        [jobKey('a', 'waiting')]: [makeJob('a3', 'j3')],
        [jobKey('b', 'active')]: [],
        [jobKey('b', 'failed')]: [makeJob('b1', 'j1'), makeJob('b2', 'j2'), makeJob('b3', 'j3')],
      },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    await store.refresh();
    expect(store.getSnapshot().tabCounts).toEqual({
      active: 2,
      waiting: 1,
      completed: 0,
      failed: 0,
      delayed: 0,
    });

    store.selectQueue('b');
    await flush();
    expect(store.getSnapshot().tabCounts).toEqual({
      active: 0,
      waiting: 0,
      completed: 0,
      failed: 3,
      delayed: 0,
    });
  });

  it('persists through a tab switch: tabCounts stays while jobPage clears, until the fresh fetch lands', async () => {
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: {
        [jobKey('a', 'active')]: [makeJob('a1', 'j1'), makeJob('a2', 'j2')],
        [jobKey('a', 'failed')]: [makeJob('a3', 'j3')],
      },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    await store.refresh();
    const initialCounts = store.getSnapshot().tabCounts;
    expect(initialCounts).toEqual({
      active: 2,
      waiting: 0,
      completed: 0,
      failed: 1,
      delayed: 0,
    });

    store.selectTab('failed');
    // Synchronously (before the async refetch resolves): jobPage is reset
    // by resetQueueOrTabSwitch, but tabCounts must still hold the last-known
    // values so the tab row doesn't flicker.
    expect(store.getSnapshot().jobPage).toBeNull();
    expect(store.getSnapshot().tabCounts).toEqual(initialCounts);

    await flush();
    // Same queue -> identical counts, now sourced from the fresh fetch.
    expect(store.getSnapshot().tabCounts).toEqual(initialCounts);
  });

  it("shows a never-visited queue's counts immediately, from what the queue table already knows", async () => {
    const state: FakeState = {
      queues: [makeQueue('a'), makeQueue('b')],
      jobs: {
        [jobKey('a', 'active')]: [makeJob('a1', 'j1'), makeJob('a2', 'j2')],
        [jobKey('b', 'active')]: [],
        [jobKey('b', 'failed')]: [makeJob('b1', 'j1'), makeJob('b2', 'j2'), makeJob('b3', 'j3')],
      },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    await store.refresh();
    expect(store.getSnapshot().tabCounts).toEqual({
      active: 2,
      waiting: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    });

    const countsForB = {
      active: 0,
      waiting: 0,
      completed: 0,
      failed: 3,
      delayed: 0,
    };

    store.selectQueue('b');
    // Synchronously, before the job-page refetch resolves: 'b' has never
    // been entered, but the queue table already fetched its counts, and
    // that's the same cache `tabCounts` reads — so the tab row shows real
    // numbers straight away instead of blank slots. They are b's own
    // counts, never queue a's.
    expect(store.getSnapshot().jobPage).toBeNull();
    expect(store.getSnapshot().tabCounts).toEqual(countsForB);

    await flush();
    // The landed fetch confirms rather than introduces them.
    expect(store.getSnapshot().tabCounts).toEqual(countsForB);
  });

  it("shows a previously-visited queue's own cached counts immediately when switching back to it", async () => {
    const state: FakeState = {
      queues: [makeQueue('a'), makeQueue('b')],
      jobs: {
        [jobKey('a', 'active')]: [makeJob('a1', 'j1'), makeJob('a2', 'j2')],
        [jobKey('b', 'failed')]: [makeJob('b1', 'j1'), makeJob('b2', 'j2'), makeJob('b3', 'j3')],
      },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    await store.refresh();
    const countsForA = store.getSnapshot().tabCounts;
    expect(countsForA).toEqual({
      active: 2,
      waiting: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    });

    store.selectQueue('b');
    await flush();
    const countsForB = store.getSnapshot().tabCounts;
    expect(countsForB).toEqual({
      active: 0,
      waiting: 0,
      completed: 0,
      failed: 3,
      delayed: 0,
    });

    store.selectQueue('a');
    // Synchronously, before the refetch resolves: queue a's OWN cached
    // counts from earlier show immediately — the whole point of caching
    // per queue rather than caching a single "last known" value.
    expect(store.getSnapshot().jobPage).toBeNull();
    expect(store.getSnapshot().tabCounts).toEqual(countsForA);

    await flush();
    expect(store.getSnapshot().tabCounts).toEqual(countsForA);
  });

  it('survives a per-queue fetch failure: a queue that starts failing keeps showing its OWN last-known counts', async () => {
    const state: FakeState = {
      queues: [makeQueue('emailQ')],
      jobs: { [jobKey('emailQ', 'active')]: [makeJob('1', 'j1'), makeJob('2', 'j2')] },
      details: {},
    };
    const deps = createFakeDeps(state);
    let failing = false;
    (deps.fetchJobPage as ReturnType<typeof vi.fn>).mockImplementation(
      async (queueName: string, status: JobStatus, page: number) => {
        if (failing) {
          throw new Error('temporary Redis blip');
        }
        return {
          ...paginate(state.jobs[jobKey(queueName, status)] ?? [], page),
          counts: countsForQueue(state, queueName),
        };
      },
    );
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    await store.refresh();
    const healthyCounts = store.getSnapshot().tabCounts;
    expect(healthyCounts).toEqual({
      active: 2,
      waiting: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    });

    failing = true;
    await store.refresh();
    const snap = store.getSnapshot();
    expect(snap.jobPage).toBeNull();
    // The job page is gone, but the counts are not: `fetchQueueCounts` is a
    // separate, lighter call that this blip didn't take out, and even if it
    // had, the queue's cache entry is left untouched rather than cleared.
    expect(snap.tabCounts).toEqual(healthyCounts);
  });

  it('a queue that fails on every attempt shows null, never a different (cached) queue’s counts', async () => {
    const state: FakeState = {
      queues: [makeQueue('a'), makeQueue('billing:invoices')],
      jobs: { [jobKey('a', 'active')]: [makeJob('a1', 'j1'), makeJob('a2', 'j2')] },
      details: {},
    };
    const deps = createFakeDeps(state);
    // A `:` in the name makes `new Queue(name, ...)` throw synchronously, so
    // in the real wiring EVERY read for this queue fails — counts included
    // (both go through `safeFetch`/the registry). The fake fails both
    // paths, or this wouldn't be a queue with no counts at all.
    (deps.fetchQueueCounts as ReturnType<typeof vi.fn>).mockImplementation(
      async (queueName: string) => {
        if (queueName === 'billing:invoices') {
          throw new Error('Queue name cannot contain :');
        }
        return countsForQueue(state, queueName);
      },
    );
    (deps.fetchJobPage as ReturnType<typeof vi.fn>).mockImplementation(
      async (queueName: string, status: JobStatus, page: number) => {
        if (queueName === 'billing:invoices') {
          throw new Error('Queue name cannot contain :');
        }
        return {
          ...paginate(state.jobs[jobKey(queueName, status)] ?? [], page),
          counts: countsForQueue(state, queueName),
        };
      },
    );
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    // 'a' sorts first alphabetically -> auto-selected and cached.
    await store.refresh();
    expect(store.getSnapshot().tabCounts).toEqual({
      active: 2,
      waiting: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    });

    // 'billing:invoices' has never had a successful read of any kind: it has
    // no cache entry, so it must show `null` — NEVER queue a's counts, even
    // though a's entry is still sitting in the same map.
    store.selectQueue('billing:invoices');
    await flush();
    const snap = store.getSnapshot();
    expect(snap.jobPage).toBeNull();
    expect(snap.tabCounts).toBeNull();
  });
});

describe('DashboardStore: navigation during an in-flight refresh (regression)', () => {
  it('does not let a completing stale refresh clobber a queue switch made while it was in flight', async () => {
    const state: FakeState = {
      queues: [makeQueue('a'), makeQueue('b'), makeQueue('c')],
      jobs: {
        [jobKey('b', 'active')]: [makeJob('b1', 'job-b1')],
        [jobKey('c', 'active')]: [makeJob('c1', 'job-c1')],
      },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh(); // establishes an initial selection ('a', the first queue)

    // Arrange for the NEXT discoverQueues() call (the one the 'b' refresh
    // below triggers) to hang, so we can deterministically interleave a
    // second navigation call while that refresh is still awaiting Redis —
    // i.e. before it has decided what "the selected queue" is.
    const { promise: discoverPromise, resolve: resolveDiscover } = deferred<QueueInfo[]>();
    (deps.discoverQueues as ReturnType<typeof vi.fn>).mockReturnValueOnce(discoverPromise);

    store.selectQueue('b'); // starts a refresh whose discoverQueues() call hangs
    store.selectQueue('c'); // switches away while that refresh is still in flight
    expect(store.getSnapshot().selectedQueueName).toBe('c');

    resolveDiscover(state.queues); // let the now-stale 'b' refresh proceed
    await flush(); // let it run to completion (or bail) ...
    await flush(); // ... and let the trailing refresh (for 'c') complete too

    const snap = store.getSnapshot();
    expect(snap.selectedQueueName).toBe('c');
    expect(snap.jobPage?.jobs).toEqual([makeJob('c1', 'job-c1')]);
  });

  it('does not let a completing stale refresh clobber a tab switch made while it was in flight', async () => {
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: {
        [jobKey('a', 'waiting')]: [makeJob('w1', 'job-w1')],
        [jobKey('a', 'completed')]: [makeJob('c1', 'job-c1')],
      },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    const { promise: discoverPromise, resolve: resolveDiscover } = deferred<QueueInfo[]>();
    (deps.discoverQueues as ReturnType<typeof vi.fn>).mockReturnValueOnce(discoverPromise);

    store.selectTab('waiting'); // starts a refresh whose discoverQueues() call hangs
    store.selectTab('completed'); // switches tab away while that refresh is in flight
    expect(store.getSnapshot().tab).toBe('completed');

    resolveDiscover(state.queues);
    await flush();
    await flush();

    const snap = store.getSnapshot();
    expect(snap.tab).toBe('completed');
    expect(snap.jobPage?.jobs).toEqual([makeJob('c1', 'job-c1')]);
  });

  it('does not let a completing stale refresh clobber a page change made while it was in flight', async () => {
    const jobs = Array.from({ length: 25 }, (_, i) => makeJob(String(i), `job-${i}`));
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: { [jobKey('a', 'waiting')]: jobs },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();
    store.selectTab('waiting');
    await flush();
    expect(store.getSnapshot().page).toBe(0);

    const { promise: discoverPromise, resolve: resolveDiscover } = deferred<QueueInfo[]>();
    (deps.discoverQueues as ReturnType<typeof vi.fn>).mockReturnValueOnce(discoverPromise);

    store.nextPage(); // -> page 1, starts a refresh whose discoverQueues() call hangs
    store.nextPage(); // -> page 2, while that refresh is still in flight
    expect(store.getSnapshot().page).toBe(2);

    resolveDiscover(state.queues);
    await flush();
    await flush();

    const snap = store.getSnapshot();
    expect(snap.page).toBe(2);
    expect(snap.jobPage?.jobs).toEqual(jobs.slice(20, 25));
  });

  it('still preserves selection by name/id across a refresh with no navigation in between (non-regression)', async () => {
    const state: FakeState = {
      queues: [makeQueue('a'), makeQueue('b')],
      jobs: { [jobKey('b', 'active')]: [makeJob('1', 'j1'), makeJob('2', 'j2')] },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    await store.refresh();
    store.selectQueue('b');
    await flush();
    store.selectNextJob();
    expect(store.getSnapshot().selectedJobId).toBe('2');

    await store.refresh();
    const snap = store.getSnapshot();
    expect(snap.selectedQueueName).toBe('b');
    expect(snap.selectedJobId).toBe('2');
  });
});

describe('DashboardStore: per-queue fetch failure isolation (regression)', () => {
  it('a rejecting fetchJobPage does not take down the connection: queues stay intact, jobPage clears, one toast', async () => {
    const state: FakeState = {
      queues: [makeQueue('billing:invoices'), makeQueue('emailQ')],
      jobs: { [jobKey('emailQ', 'active')]: [makeJob('1', 'j1')] },
      details: {},
    };
    const deps = createFakeDeps(state);
    (deps.fetchJobPage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Queue name cannot contain :'),
    );
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    // 'billing:invoices' sorts first alphabetically -> auto-selected.
    await store.refresh();

    const snap = store.getSnapshot();
    expect(snap.connection).toEqual({ state: 'ready' });
    expect(snap.queues).toEqual(state.queues);
    expect(snap.selectedQueueName).toBe('billing:invoices');
    expect(snap.jobPage).toBeNull();
    expect(snap.visibleJobs).toEqual([]);
    expect(snap.toasts).toHaveLength(1);
    expect(snap.toasts[0].message).toBe(
      'Could not load queue "billing:invoices": Queue name cannot contain :',
    );
    expect(snap.refreshing).toBe(false);
  });

  it('does not flood a toast per poll tick while the same queue keeps failing', async () => {
    const state: FakeState = { queues: [makeQueue('billing:invoices')], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    (deps.fetchJobPage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('nope'));
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    await store.refresh();
    expect(store.getSnapshot().toasts).toHaveLength(1);

    // Simulate two more poll ticks against the still-failing queue.
    await store.refresh();
    await store.refresh();

    expect(deps.fetchJobPage).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot().toasts).toHaveLength(1);
  });

  it('selecting another (working) queue recovers, and re-failing the bad queue later toasts again', async () => {
    const state: FakeState = {
      queues: [makeQueue('billing:invoices'), makeQueue('emailQ')],
      jobs: { [jobKey('emailQ', 'active')]: [makeJob('1', 'j1')] },
      details: {},
    };
    const deps = createFakeDeps(state);
    (deps.fetchJobPage as ReturnType<typeof vi.fn>).mockImplementation(
      async (queueName: string, status: JobStatus, page: number) => {
        if (queueName === 'billing:invoices') {
          throw new Error('Queue name cannot contain :');
        }
        return {
          ...paginate(state.jobs[jobKey(queueName, status)] ?? [], page),
          counts: countsForQueue(state, queueName),
        };
      },
    );
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    await store.refresh();
    expect(store.getSnapshot().toasts).toHaveLength(1);
    expect(store.getSnapshot().jobPage).toBeNull();

    store.selectQueue('emailQ');
    await flush();
    const recovered = store.getSnapshot();
    expect(recovered.connection).toEqual({ state: 'ready' });
    expect(recovered.jobPage?.jobs).toEqual([makeJob('1', 'j1')]);
    // No new toast from the successful switch (still just the original one,
    // which auto-dismisses on its own timer independent of this).
    expect(recovered.toasts).toHaveLength(1);

    // Switching back to the still-broken queue toasts again (a fresh
    // failure after a successful fetch resets the dedupe tracking).
    store.selectQueue('billing:invoices');
    await flush();
    expect(store.getSnapshot().toasts).toHaveLength(2);
    expect(store.getSnapshot().jobPage).toBeNull();
  });

  it('a rejecting syncRegistry is handled the same non-fatal way', async () => {
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: { [jobKey('a', 'active')]: [makeJob('1', 'j1')] },
      details: {},
    };
    const deps = createFakeDeps(state);
    (deps.syncRegistry as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('registry sync boom'),
    );
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    await store.refresh();

    const snap = store.getSnapshot();
    expect(snap.connection).toEqual({ state: 'ready' });
    expect(snap.queues).toEqual(state.queues);
    expect(snap.jobPage).toBeNull();
    expect(snap.toasts).toHaveLength(1);
    expect(snap.toasts[0].message).toBe('Could not load queue "a": registry sync boom');

    // A subsequent, successful refresh recovers fully.
    await store.refresh();
    const recovered = store.getSnapshot();
    expect(recovered.jobPage?.jobs).toEqual([makeJob('1', 'j1')]);
    expect(recovered.toasts).toHaveLength(1); // still just the first toast
  });

  it('a discoverQueues rejection remains a connection-level error, not a per-queue toast', async () => {
    const state: FakeState = { queues: [makeQueue('a')], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    (deps.discoverQueues as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('ECONNREFUSED'),
    );
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    await store.refresh();

    const snap = store.getSnapshot();
    expect(snap.connection).toEqual({ state: 'error', url: 'redis://x', message: 'ECONNREFUSED' });
    expect(snap.toasts).toHaveLength(0); // connection-level failures use the error screen, not a toast
  });
});

describe('DashboardStore: polling', () => {
  it('ticks every pollIntervalMs while polling', async () => {
    const state: FakeState = { queues: [makeQueue('a')], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x', pollIntervalMs: 3000 }));

    store.startPolling();
    expect(deps.discoverQueues).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(deps.discoverQueues).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(deps.discoverQueues).toHaveBeenCalledTimes(2);

    store.stopPolling();
    await vi.advanceTimersByTimeAsync(6000);
    expect(deps.discoverQueues).toHaveBeenCalledTimes(2);
  });

  it('stopPolling is safe to call when not polling', () => {
    const deps = createFakeDeps({ queues: [], jobs: {}, details: {} });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    expect(() => store.stopPolling()).not.toThrow();
    expect(() => store.stopPolling()).not.toThrow();
  });

  it('manual refresh resets the interval so the next auto-tick is a full interval away', async () => {
    const state: FakeState = { queues: [makeQueue('a')], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x', pollIntervalMs: 3000 }));
    store.startPolling();

    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.discoverQueues).not.toHaveBeenCalled();

    await store.refresh();
    expect(deps.discoverQueues).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2999);
    expect(deps.discoverQueues).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(deps.discoverQueues).toHaveBeenCalledTimes(2);
  });
});

describe('DashboardStore: navigation (tab/queue/page)', () => {
  it('selectQueue resets page, selected job, and search but keeps the tab', async () => {
    const state: FakeState = {
      queues: [makeQueue('a'), makeQueue('b')],
      jobs: {
        [jobKey('a', 'failed')]: [makeJob('1', 'j1')],
        [jobKey('b', 'failed')]: [makeJob('2', 'j2')],
      },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    await store.refresh();
    store.selectTab('failed');
    await flush();
    store.openSearch();
    store.setSearchQuery('j1');
    expect(store.getSnapshot().tab).toBe('failed');

    store.selectQueue('b');
    const snapAfterSwitch = store.getSnapshot();
    expect(snapAfterSwitch.selectedQueueName).toBe('b');
    expect(snapAfterSwitch.tab).toBe('failed');
    expect(snapAfterSwitch.page).toBe(0);
    expect(snapAfterSwitch.selectedJobId).toBeNull();
    expect(snapAfterSwitch.search).toEqual({ active: false, query: '' });

    await flush();
    expect(store.getSnapshot().jobPage?.jobs).toEqual([makeJob('2', 'j2')]);
  });

  it('selectQueue accepts a 0-based index and ignores unknown names/indexes', async () => {
    const state: FakeState = { queues: [makeQueue('a'), makeQueue('b')], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    await store.refresh();
    store.selectQueue(1);
    expect(store.getSnapshot().selectedQueueName).toBe('b');

    store.selectQueue('unknown');
    expect(store.getSnapshot().selectedQueueName).toBe('b');

    store.selectQueue(99);
    expect(store.getSnapshot().selectedQueueName).toBe('b');

    // no-op: selecting the currently-selected queue again
    store.selectQueue('b');
    expect(store.getSnapshot().selectedQueueName).toBe('b');
  });

  it('selectTab resets page and search, accepts a 1-based index, and ignores invalid input', async () => {
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: { [jobKey('a', 'waiting')]: [makeJob('1', 'j1')] },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    await store.refresh();
    store.openSearch();
    store.setSearchQuery('x');

    store.selectTab(2); // 1-based -> 'waiting'
    expect(store.getSnapshot().tab).toBe('waiting');
    expect(store.getSnapshot().search).toEqual({ active: false, query: '' });

    // out-of-range index: no-op
    store.selectTab(99);
    expect(store.getSnapshot().tab).toBe('waiting');

    // same tab again: no-op
    store.selectTab('waiting');
    expect(store.getSnapshot().tab).toBe('waiting');

    await flush();
    expect(store.getSnapshot().jobPage?.jobs).toEqual([makeJob('1', 'j1')]);
  });

  it('selectAdjacentTab walks the lifecycle order in both directions', async () => {
    const state: FakeState = { queues: [makeQueue('a')], jobs: {}, details: {} };
    const store = track(new DashboardStore(createFakeDeps(state), { redisUrl: 'redis://x' }));
    await store.refresh();
    store.selectTab('delayed');
    await flush();

    const forwards: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      store.selectAdjacentTab(1);
      await flush();
      forwards.push(store.getSnapshot().tab);
    }
    expect(forwards).toEqual(['waiting', 'active', 'failed', 'completed']);

    const backwards: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      store.selectAdjacentTab(-1);
      await flush();
      backwards.push(store.getSnapshot().tab);
    }
    expect(backwards).toEqual(['failed', 'active', 'waiting', 'delayed']);
  });

  it('selectAdjacentTab clamps at both ends instead of wrapping', async () => {
    const state: FakeState = { queues: [makeQueue('a')], jobs: {}, details: {} };
    const store = track(new DashboardStore(createFakeDeps(state), { redisUrl: 'redis://x' }));
    await store.refresh();
    store.selectTab('delayed');
    await flush();

    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });

    // First tab: stepping back is a true no-op, not a wrap to Completed.
    store.selectAdjacentTab(-1);
    expect(store.getSnapshot().tab).toBe('delayed');
    expect(notified).toBe(0);

    store.selectTab('completed');
    await flush();
    notified = 0;

    // Last tab: stepping on does not wrap round to Delayed.
    store.selectAdjacentTab(1);
    expect(store.getSnapshot().tab).toBe('completed');
    expect(notified).toBe(0);
  });

  it('selectAdjacentTab resets page and search, exactly as the 1-5 keys do', async () => {
    const jobs = Array.from({ length: 25 }, (_, i) => makeJob(String(i), `job-${i}`));
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: { [jobKey('a', 'delayed')]: jobs },
      details: {},
    };
    const store = track(new DashboardStore(createFakeDeps(state), { redisUrl: 'redis://x' }));
    await store.refresh();
    store.selectTab('delayed');
    await flush();
    store.nextPage();
    await flush();
    store.openSearch();
    store.setSearchQuery('job-1');
    expect(store.getSnapshot().page).toBe(1);

    store.selectAdjacentTab(1);

    expect(store.getSnapshot().tab).toBe('waiting');
    expect(store.getSnapshot().page).toBe(0);
    expect(store.getSnapshot().selectedJobId).toBeNull();
    expect(store.getSnapshot().search).toEqual({ active: false, query: '' });
  });

  it('paginates and clamps at both ends', async () => {
    const jobs = Array.from({ length: 25 }, (_, i) => makeJob(String(i), `job-${i}`));
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: { [jobKey('a', 'waiting')]: jobs },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    await store.refresh();
    store.selectTab('waiting');
    await flush();
    expect(store.getSnapshot().jobPage?.pageCount).toBe(3);
    expect(store.getSnapshot().page).toBe(0);

    store.prevPage(); // clamp at start: no-op
    await flush();
    expect(store.getSnapshot().page).toBe(0);

    store.nextPage();
    await flush();
    expect(store.getSnapshot().page).toBe(1);

    store.nextPage();
    await flush();
    expect(store.getSnapshot().page).toBe(2);

    store.nextPage(); // clamp at end: no-op
    await flush();
    expect(store.getSnapshot().page).toBe(2);

    store.prevPage();
    await flush();
    expect(store.getSnapshot().page).toBe(1);
  });

  it('nextPage/prevPage are no-ops before any job page has loaded', () => {
    const deps = createFakeDeps({ queues: [], jobs: {}, details: {} });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    expect(() => store.nextPage()).not.toThrow();
    expect(() => store.prevPage()).not.toThrow();
    expect(store.getSnapshot().page).toBe(0);
  });

  it('selectNextJob/selectPrevJob clamp within the visible (filtered) list', async () => {
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: {
        [jobKey('a', 'active')]: [
          makeJob('1', 'alpha'),
          makeJob('2', 'beta'),
          makeJob('3', 'alpha-two'),
        ],
      },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    store.setSearchQuery('alpha');
    expect(store.getSnapshot().visibleJobs.map((j) => j.id)).toEqual(['1', '3']);

    // selectedJobId ('1') is still in the filtered view; move forward.
    store.selectNextJob();
    expect(store.getSnapshot().selectedJobId).toBe('3');
    store.selectNextJob(); // clamp at the end
    expect(store.getSnapshot().selectedJobId).toBe('3');

    store.selectPrevJob();
    expect(store.getSnapshot().selectedJobId).toBe('1');
    store.selectPrevJob(); // clamp at the start
    expect(store.getSnapshot().selectedJobId).toBe('1');
  });

  it('selectNextJob falls back to the first visible job when the current selection is filtered out', async () => {
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: { [jobKey('a', 'active')]: [makeJob('1', 'alpha'), makeJob('2', 'beta')] },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();
    expect(store.getSnapshot().selectedJobId).toBe('1');

    store.setSearchQuery('beta'); // excludes the currently-selected job '1'
    store.selectNextJob();
    expect(store.getSnapshot().selectedJobId).toBe('2');
  });

  it('selectPrevJob falls back to the first visible job when the current selection is filtered out', async () => {
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: { [jobKey('a', 'active')]: [makeJob('1', 'alpha'), makeJob('2', 'beta')] },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();
    expect(store.getSnapshot().selectedJobId).toBe('1');

    store.setSearchQuery('beta'); // excludes the currently-selected job '1'
    store.selectPrevJob();
    expect(store.getSnapshot().selectedJobId).toBe('2');
  });

  it('selectNextJob/selectPrevJob are no-ops when the visible list is empty', async () => {
    const state: FakeState = { queues: [makeQueue('a')], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();
    expect(() => store.selectNextJob()).not.toThrow();
    expect(() => store.selectPrevJob()).not.toThrow();
    expect(store.getSnapshot().selectedJobId).toBeNull();
  });
});

describe('DashboardStore: focus', () => {
  it('setFocus/toggleFocus switch between sidebar and jobs, no-op on redundant set', () => {
    const deps = createFakeDeps({ queues: [], jobs: {}, details: {} });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    expect(store.getSnapshot().focus).toBe('sidebar');

    store.setFocus('sidebar'); // no-op
    expect(store.getSnapshot().focus).toBe('sidebar');

    store.toggleFocus();
    expect(store.getSnapshot().focus).toBe('jobs');

    store.toggleFocus();
    expect(store.getSnapshot().focus).toBe('sidebar');
  });
});

describe('DashboardStore: search', () => {
  it('filters by id and name case-insensitively; closeSearch clears both flag and query', async () => {
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: {
        [jobKey('a', 'active')]: [makeJob('abc-123', 'send-email'), makeJob('xyz-999', 'send-sms')],
      },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    store.openSearch();
    expect(store.getSnapshot().search.active).toBe(true);
    store.openSearch(); // no-op, already active

    store.setSearchQuery('EMAIL');
    expect(store.getSnapshot().visibleJobs.map((j) => j.id)).toEqual(['abc-123']);

    store.setSearchQuery('XYZ');
    expect(store.getSnapshot().visibleJobs.map((j) => j.id)).toEqual(['xyz-999']);

    store.closeSearch();
    const snap = store.getSnapshot();
    expect(snap.search).toEqual({ active: false, query: '' });
    expect(snap.visibleJobs).toHaveLength(2);
  });

  it('closeSearch is a no-op when search is already inactive and empty', () => {
    const deps = createFakeDeps({ queues: [], jobs: {}, details: {} });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    expect(() => store.closeSearch()).not.toThrow();
    expect(store.getSnapshot().search).toEqual({ active: false, query: '' });
  });

  it('acceptSearch closes the input but keeps the query filtering the list', async () => {
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: {
        [jobKey('a', 'active')]: [makeJob('abc-123', 'send-email'), makeJob('xyz-999', 'send-sms')],
      },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    store.openSearch();
    store.setSearchQuery('email');
    store.acceptSearch();

    const snap = store.getSnapshot();
    expect(snap.search).toEqual({ active: false, query: 'email' });
    expect(snap.visibleJobs.map((j) => j.id)).toEqual(['abc-123']);
  });

  it('acceptSearch is a no-op when search is not active', () => {
    const deps = createFakeDeps({ queues: [], jobs: {}, details: {} });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    expect(() => store.acceptSearch()).not.toThrow();
    expect(store.getSnapshot().search).toEqual({ active: false, query: '' });
  });

  it('openSearch after acceptSearch resumes editing the still-applied query rather than discarding it', async () => {
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: {
        [jobKey('a', 'active')]: [makeJob('abc-123', 'send-email'), makeJob('xyz-999', 'send-sms')],
      },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    store.openSearch();
    store.setSearchQuery('email');
    store.acceptSearch();
    expect(store.getSnapshot().search).toEqual({ active: false, query: 'email' });

    store.openSearch();
    const snap = store.getSnapshot();
    expect(snap.search).toEqual({ active: true, query: 'email' });
    expect(snap.visibleJobs.map((j) => j.id)).toEqual(['abc-123']);
  });
});

describe('DashboardStore: connection', () => {
  it('reflects connection status and auto-refreshes only on transition into ready', async () => {
    const state: FakeState = { queues: [makeQueue('a')], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    store.onConnectionStatus({ state: 'error', url: 'redis://x', message: 'ECONNREFUSED' });
    expect(store.getSnapshot().connection).toEqual({
      state: 'error',
      url: 'redis://x',
      message: 'ECONNREFUSED',
    });
    expect(deps.discoverQueues).not.toHaveBeenCalled();

    store.onConnectionStatus({ state: 'ready' });
    await flush();
    expect(store.getSnapshot().connection).toEqual({ state: 'ready' });
    expect(deps.discoverQueues).toHaveBeenCalledTimes(1);

    // Already ready: no additional refresh triggered.
    store.onConnectionStatus({ state: 'ready' });
    await flush();
    expect(deps.discoverQueues).toHaveBeenCalledTimes(1);
  });
});

describe('DashboardStore: jobsHiddenBySearch', () => {
  const stateWithThreeJobs = (): FakeState => ({
    queues: [makeQueue('a')],
    jobs: {
      [jobKey('a', 'active')]: [
        makeJob('1', 'sendEmail'),
        makeJob('2', 'sendSms'),
        makeJob('3', 'sendPush'),
      ],
    },
    details: {},
  });

  it('is 0 with no query applied', async () => {
    const store = track(
      new DashboardStore(createFakeDeps(stateWithThreeJobs()), { redisUrl: 'redis://x' }),
    );
    await store.refresh();
    expect(store.getSnapshot().visibleJobs).toHaveLength(3);
    expect(store.getSnapshot().jobsHiddenBySearch).toBe(0);
  });

  it('counts the rows a partially-matching query hides', async () => {
    const store = track(
      new DashboardStore(createFakeDeps(stateWithThreeJobs()), { redisUrl: 'redis://x' }),
    );
    await store.refresh();

    store.openSearch();
    store.setSearchQuery('sendS');
    expect(store.getSnapshot().visibleJobs).toHaveLength(1);
    expect(store.getSnapshot().jobsHiddenBySearch).toBe(2);
  });

  it('counts every row when the query matches nothing, which is what makes the list blank', async () => {
    const store = track(
      new DashboardStore(createFakeDeps(stateWithThreeJobs()), { redisUrl: 'redis://x' }),
    );
    await store.refresh();

    store.openSearch();
    store.setSearchQuery('nope');
    expect(store.getSnapshot().visibleJobs).toHaveLength(0);
    expect(store.getSnapshot().jobsHiddenBySearch).toBe(3);
  });

  it('stays 0 when the status is genuinely empty, query or not', async () => {
    const state: FakeState = { queues: [makeQueue('a')], jobs: {}, details: {} };
    const store = track(new DashboardStore(createFakeDeps(state), { redisUrl: 'redis://x' }));
    await store.refresh();

    expect(store.getSnapshot().jobsHiddenBySearch).toBe(0);
    store.openSearch();
    store.setSearchQuery('nope');
    // Nothing was hidden because there was nothing there — the empty status,
    // not the query, is why the list has no rows.
    expect(store.getSnapshot().jobsHiddenBySearch).toBe(0);
  });

  it('treats a whitespace-only query as no filter', async () => {
    const store = track(
      new DashboardStore(createFakeDeps(stateWithThreeJobs()), { redisUrl: 'redis://x' }),
    );
    await store.refresh();

    store.openSearch();
    store.setSearchQuery('   ');
    expect(store.getSnapshot().visibleJobs).toHaveLength(3);
    expect(store.getSnapshot().jobsHiddenBySearch).toBe(0);
  });

  it('resets to 0 once the query is cleared', async () => {
    const store = track(
      new DashboardStore(createFakeDeps(stateWithThreeJobs()), { redisUrl: 'redis://x' }),
    );
    await store.refresh();

    store.openSearch();
    store.setSearchQuery('nope');
    expect(store.getSnapshot().jobsHiddenBySearch).toBe(3);

    store.closeSearch();
    expect(store.getSnapshot().jobsHiddenBySearch).toBe(0);
  });
});

describe('DashboardStore: jobsLoading', () => {
  const stateWithTwoTabs = (): FakeState => ({
    queues: [makeQueue('a'), makeQueue('b')],
    jobs: {
      [jobKey('a', 'active')]: [makeJob('a1', 'j1')],
      [jobKey('a', 'failed')]: [makeJob('a2', 'j2')],
    },
    details: {},
  });

  it('is false before anything has been asked for, and after a refresh lands', async () => {
    const deps = createFakeDeps(stateWithTwoTabs());
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    expect(store.getSnapshot().jobsLoading).toBe(false);
    await store.refresh();
    expect(store.getSnapshot().jobsLoading).toBe(false);
  });

  it('covers the window where a tab switch has cleared the page but the fetch has not landed', async () => {
    const state = stateWithTwoTabs();
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    const { promise, resolve } = deferred<JobPage>();
    (deps.fetchJobPage as ReturnType<typeof vi.fn>).mockReturnValueOnce(promise);

    store.selectTab('failed');
    // Synchronously: the page is gone and its replacement is in flight, so
    // an empty job list means "not loaded yet" — the tab row's count for
    // this status says 1.
    expect(store.getSnapshot().jobPage).toBeNull();
    expect(store.getSnapshot().jobsLoading).toBe(true);
    expect(store.getSnapshot().tabCounts?.failed).toBe(1);

    resolve({
      ...paginate(state.jobs[jobKey('a', 'failed')] ?? [], 0),
      counts: countsForQueue(state, 'a'),
    });
    await flush();
    expect(store.getSnapshot().jobsLoading).toBe(false);
    expect(store.getSnapshot().jobPage?.jobs).toHaveLength(1);
  });

  it('covers a queue switch the same way', async () => {
    const deps = createFakeDeps(stateWithTwoTabs());
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    (deps.fetchJobPage as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      deferred<JobPage>().promise,
    );
    store.selectQueue('b');
    expect(store.getSnapshot().jobsLoading).toBe(true);
  });

  it('clears on a FAILED fetch, so a broken queue falls back to the empty table and not to a loading message forever', async () => {
    const deps = createFakeDeps(stateWithTwoTabs());
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    (deps.fetchJobPage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Redis blip'));
    store.selectTab('failed');
    expect(store.getSnapshot().jobsLoading).toBe(true);

    await flush();
    const snap = store.getSnapshot();
    expect(snap.jobPage).toBeNull();
    expect(snap.jobsLoading).toBe(false);
    expect(snap.toasts[0]?.message).toContain('Could not load queue "a"');
  });

  it('is not cleared by a refresh that a later navigation superseded', async () => {
    const state = stateWithTwoTabs();
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    // The 'failed' fetch hangs; while it does, the user moves on to another
    // tab. The stale cycle must not report "loaded" for a page nobody is
    // waiting for any more.
    const stale = deferred<JobPage>();
    (deps.fetchJobPage as ReturnType<typeof vi.fn>).mockReturnValueOnce(stale.promise);
    store.selectTab('failed');
    store.selectTab('waiting');
    expect(store.getSnapshot().jobsLoading).toBe(true);

    stale.resolve({
      ...paginate(state.jobs[jobKey('a', 'failed')] ?? [], 0),
      counts: countsForQueue(state, 'a'),
    });
    await flush();
    // The 'waiting' fetch is what clears it, having actually landed.
    expect(store.getSnapshot().jobsLoading).toBe(false);
    expect(store.getSnapshot().tab).toBe('waiting');
  });

  it('is not set by paging, which keeps the previous rows on screen', async () => {
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: {
        [jobKey('a', 'active')]: Array.from({ length: 25 }, (_, i) => makeJob(`j${i}`, 'job')),
      },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    (deps.fetchJobPage as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      deferred<JobPage>().promise,
    );
    store.nextPage();
    expect(store.getSnapshot().jobsLoading).toBe(false);
    expect(store.getSnapshot().jobPage?.jobs).toHaveLength(10);
  });
});

describe('DashboardStore: initialLoadComplete', () => {
  it('stays false until the first refresh cycle resolves', async () => {
    const state: FakeState = { queues: [makeQueue('a')], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    const gate = deferred<QueueInfo[]>();
    deps.discoverQueues = vi.fn(() => gate.promise);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    expect(store.getSnapshot().initialLoadComplete).toBe(false);

    const refreshing = store.refresh();
    await flush();
    // Discovery is still in flight: nothing is known about this Redis yet.
    expect(store.getSnapshot().initialLoadComplete).toBe(false);
    expect(store.getSnapshot().queues).toEqual([]);

    gate.resolve(state.queues);
    await refreshing;
    expect(store.getSnapshot().initialLoadComplete).toBe(true);
  });

  it('is not implied by the redis client reporting ready', async () => {
    const state: FakeState = { queues: [makeQueue('a')], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    deps.discoverQueues = vi.fn(() => deferred<QueueInfo[]>().promise);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    // The client's 'ready' event fires long before SCAN-based discovery
    // returns, so `connection.state` alone can't gate the loading screen.
    store.onConnectionStatus({ state: 'ready' });
    await flush();
    expect(store.getSnapshot().connection).toEqual({ state: 'ready' });
    expect(store.getSnapshot().initialLoadComplete).toBe(false);
  });

  it('flips to true when discovery legitimately finds no queues', async () => {
    const state: FakeState = { queues: [], jobs: {}, details: {} };
    const store = track(new DashboardStore(createFakeDeps(state), { redisUrl: 'redis://x' }));

    await store.refresh();
    expect(store.getSnapshot().initialLoadComplete).toBe(true);
    expect(store.getSnapshot().queues).toEqual([]);
  });

  it('stays false while the first refresh keeps failing, then latches on success', async () => {
    const state: FakeState = { queues: [makeQueue('a')], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    deps.discoverQueues = vi
      .fn<StoreDeps['discoverQueues']>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(state.queues);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    await store.refresh();
    expect(store.getSnapshot().connection.state).toBe('error');
    expect(store.getSnapshot().initialLoadComplete).toBe(false);

    await store.refresh();
    expect(store.getSnapshot().initialLoadComplete).toBe(true);
  });

  it('is never reset once latched, so a later failure keeps the data on screen', async () => {
    const state: FakeState = { queues: [makeQueue('a')], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    await store.refresh();
    expect(store.getSnapshot().initialLoadComplete).toBe(true);

    deps.discoverQueues = vi.fn(async () => {
      throw new Error('connection lost');
    });
    await store.refresh();
    expect(store.getSnapshot().connection.state).toBe('error');
    expect(store.getSnapshot().initialLoadComplete).toBe(true);
  });
});

describe('DashboardStore: detail view', () => {
  it('opens the detail view for the selected job', async () => {
    const detail: JobDetail = {
      id: '1',
      name: 'j1',
      attemptsMade: 1,
      timestamp: 0,
      progress: 50,
      data: { foo: 'bar' },
      returnvalue: null,
      stacktrace: [],
      opts: {},
      timestamps: { created: 0, processed: null, finished: null },
      rawProgress: 50,
    };
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: { [jobKey('a', 'active')]: [makeJob('1', 'j1')] },
      details: { [detailKey('a', '1')]: detail },
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    const p = store.openDetail();
    expect(store.getSnapshot().detailLoading).toBe(true);
    await p;

    const snap = store.getSnapshot();
    expect(snap.detail).toEqual(detail);
    expect(snap.detailLoading).toBe(false);

    store.closeDetail();
    expect(store.getSnapshot().detail).toBeNull();
    store.closeDetail(); // no-op
  });

  it('openDetail is a no-op when nothing is selected', async () => {
    const deps = createFakeDeps({ queues: [], jobs: {}, details: {} });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.openDetail();
    expect(deps.getJobDetail).not.toHaveBeenCalled();
    expect(store.getSnapshot().detail).toBeNull();
  });

  it('openDetail pushes a toast when the job has disappeared', async () => {
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: { [jobKey('a', 'active')]: [makeJob('1', 'j1')] },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    await store.openDetail();
    const snap = store.getSnapshot();
    expect(snap.detail).toBeNull();
    expect(snap.toasts).toHaveLength(1);
    expect(snap.toasts[0].message).toContain('not found');
  });

  it('openDetail toasts and clears detailLoading when getJobDetail rejects, without an unhandled rejection', async () => {
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: { [jobKey('a', 'active')]: [makeJob('1', 'j1')] },
      details: {},
    };
    const deps = createFakeDeps(state);
    (deps.getJobDetail as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('connection reset'),
    );
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    const p = store.openDetail();
    expect(store.getSnapshot().detailLoading).toBe(true);
    await expect(p).resolves.toBeUndefined(); // never rejects/throws

    const snap = store.getSnapshot();
    expect(snap.detailLoading).toBe(false);
    expect(snap.detail).toBeNull();
    expect(snap.toasts).toHaveLength(1);
    expect(snap.toasts[0].message).toBe('Could not load job 1: connection reset');
  });

  it('openDetail stringifies a non-Error rejection from getJobDetail', async () => {
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: { [jobKey('a', 'active')]: [makeJob('1', 'j1')] },
      details: {},
    };
    const deps = createFakeDeps(state);
    (deps.getJobDetail as ReturnType<typeof vi.fn>).mockRejectedValueOnce('plain-string-error');
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    await store.openDetail();
    const snap = store.getSnapshot();
    expect(snap.detailLoading).toBe(false);
    expect(snap.toasts[0].message).toBe('Could not load job 1: plain-string-error');
  });
});

describe('DashboardStore: drain flow', () => {
  it('requires request -> confirm; cancel aborts without calling the action', async () => {
    const state: FakeState = { queues: [makeQueue('a')], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    store.cancelDrain(); // no-op, nothing pending
    expect(store.getSnapshot().confirmDrain).toBe(false);

    store.requestDrain();
    expect(store.getSnapshot().confirmDrain).toBe(true);
    store.requestDrain(); // no-op, already pending

    store.cancelDrain();
    expect(store.getSnapshot().confirmDrain).toBe(false);
    expect(deps.actions.drain).not.toHaveBeenCalled();

    store.requestDrain();
    await store.confirmDrain();
    expect(store.getSnapshot().confirmDrain).toBe(false);
    expect(deps.actions.drain).toHaveBeenCalledWith('a');
    expect(store.getSnapshot().toasts.map((t) => t.message)).toEqual(['Queue drained']);
  });

  it('confirmDrain without a prior request is a no-op', async () => {
    const deps = createFakeDeps({ queues: [], jobs: {}, details: {} });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.confirmDrain();
    expect(deps.actions.drain).not.toHaveBeenCalled();
  });

  it('requestDrain is a no-op when no queue is selected', () => {
    const deps = createFakeDeps({ queues: [], jobs: {}, details: {} });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    store.requestDrain();
    expect(store.getSnapshot().confirmDrain).toBe(false);
  });

  it('toasts the failure message when drain fails, without refreshing', async () => {
    const state: FakeState = { queues: [makeQueue('a')], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    (deps.actions.drain as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      message: 'drain failed',
    });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();
    const callsBefore = (deps.discoverQueues as ReturnType<typeof vi.fn>).mock.calls.length;

    store.requestDrain();
    await store.confirmDrain();

    expect(store.getSnapshot().toasts.map((t) => t.message)).toEqual(['drain failed']);
    expect(deps.discoverQueues).toHaveBeenCalledTimes(callsBefore);
  });

  it('uses a custom info message from the action result when present', async () => {
    const state: FakeState = { queues: [makeQueue('a')], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    (deps.actions.drain as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      info: 'Custom drained message',
    });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    store.requestDrain();
    await store.confirmDrain();
    expect(store.getSnapshot().toasts.map((t) => t.message)).toEqual(['Custom drained message']);
  });
});

describe('DashboardStore: duplicate flow', () => {
  const stateWithJob = (): FakeState => ({
    queues: [makeQueue('a')],
    jobs: { [jobKey('a', 'active')]: [makeJob('1', 'j1')] },
    details: {},
  });

  it('requires request -> confirm; cancel aborts without calling the action', async () => {
    const deps = createFakeDeps(stateWithJob());
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    store.cancelDuplicate(); // no-op, nothing pending
    expect(store.getSnapshot().confirmDuplicateJobId).toBeNull();

    store.requestDuplicate();
    expect(store.getSnapshot().confirmDuplicateJobId).toBe('1');
    store.requestDuplicate(); // no-op, already pending

    store.cancelDuplicate();
    expect(store.getSnapshot().confirmDuplicateJobId).toBeNull();
    expect(deps.actions.duplicate).not.toHaveBeenCalled();

    store.requestDuplicate();
    await store.confirmDuplicate();
    expect(store.getSnapshot().confirmDuplicateJobId).toBeNull();
    expect(deps.actions.duplicate).toHaveBeenCalledWith('a', '1');
    expect(store.getSnapshot().toasts.map((t) => t.message)).toEqual(['Job 1 duplicated']);
  });

  it('confirmDuplicate without a prior request is a no-op', async () => {
    const deps = createFakeDeps({ queues: [], jobs: {}, details: {} });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.confirmDuplicate();
    expect(deps.actions.duplicate).not.toHaveBeenCalled();
  });

  it('requestDuplicate is a no-op when no job is selected', async () => {
    const deps = createFakeDeps({ queues: [makeQueue('a')], jobs: {}, details: {} });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh(); // queue selected, but its tab has no jobs
    store.requestDuplicate();
    expect(store.getSnapshot().confirmDuplicateJobId).toBeNull();
  });

  it('confirming acts on the job captured at request time, not the drifted selection', async () => {
    const state = stateWithJob();
    state.jobs[jobKey('a', 'active')] = [makeJob('1', 'j1'), makeJob('2', 'j2')];
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    store.requestDuplicate(); // captures job '1'
    // Job '1' vanishes and a poll refresh re-resolves the selection to '2'
    // while the prompt is still up.
    state.jobs[jobKey('a', 'active')] = [makeJob('2', 'j2')];
    await store.refresh();
    expect(store.getSnapshot().selectedJobId).toBe('2');
    expect(store.getSnapshot().confirmDuplicateJobId).toBe('1');

    await store.confirmDuplicate();
    expect(deps.actions.duplicate).toHaveBeenCalledWith('a', '1');
  });

  it('toasts the failure message when duplicate fails, without refreshing', async () => {
    const deps = createFakeDeps(stateWithJob());
    (deps.actions.duplicate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      message: 'duplicate failed',
    });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();
    const callsBefore = (deps.discoverQueues as ReturnType<typeof vi.fn>).mock.calls.length;

    store.requestDuplicate();
    await store.confirmDuplicate();

    expect(store.getSnapshot().toasts.map((t) => t.message)).toEqual(['duplicate failed']);
    expect(deps.discoverQueues).toHaveBeenCalledTimes(callsBefore);
  });

  it('uses a custom info message from the action result when present', async () => {
    const deps = createFakeDeps(stateWithJob());
    (deps.actions.duplicate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      info: 'Job 1 duplicated as delayed job 42',
    });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    store.requestDuplicate();
    await store.confirmDuplicate();
    expect(store.getSnapshot().toasts.map((t) => t.message)).toEqual([
      'Job 1 duplicated as delayed job 42',
    ]);
  });
});

describe('DashboardStore: job/queue actions', () => {
  it('a failed action pushes a toast that auto-dismisses after toastDurationMs', async () => {
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: { [jobKey('a', 'failed')]: [makeJob('1', 'j1')] },
      details: {},
    };
    const deps = createFakeDeps(state);
    (deps.actions.retry as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      message: 'cannot retry',
    });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x', toastDurationMs: 100 }));
    await store.refresh();
    store.selectTab('failed');
    await flush();

    await store.retrySelected();
    expect(store.getSnapshot().toasts).toHaveLength(1);
    expect(store.getSnapshot().toasts[0].message).toBe('cannot retry');

    await vi.advanceTimersByTimeAsync(100);
    expect(store.getSnapshot().toasts).toHaveLength(0);
  });

  it('a successful action triggers a refresh (no toast when info is absent)', async () => {
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: { [jobKey('a', 'active')]: [makeJob('1', 'j1')] },
      details: {},
    };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();
    const callsBefore = (deps.discoverQueues as ReturnType<typeof vi.fn>).mock.calls.length;

    await store.deleteSelected();
    expect(deps.actions.delete).toHaveBeenCalledWith('a', '1');
    expect(deps.discoverQueues).toHaveBeenCalledTimes(callsBefore + 1);
    expect(store.getSnapshot().toasts).toHaveLength(0);
  });

  it('a successful action with an info message pushes an info toast', async () => {
    const state: FakeState = {
      queues: [makeQueue('a')],
      jobs: { [jobKey('a', 'delayed')]: [makeJob('1', 'j1')] },
      details: {},
    };
    const deps = createFakeDeps(state);
    (deps.actions.promote as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      info: 'Promoted',
    });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();
    store.selectTab('delayed');
    await flush();

    await store.promoteSelected();
    expect(store.getSnapshot().toasts.map((t) => t.message)).toEqual(['Promoted']);
  });

  it('retrySelected/deleteSelected/promoteSelected are no-ops without a selected job', async () => {
    const deps = createFakeDeps({ queues: [], jobs: {}, details: {} });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.retrySelected();
    await store.deleteSelected();
    await store.promoteSelected();
    expect(deps.actions.retry).not.toHaveBeenCalled();
    expect(deps.actions.delete).not.toHaveBeenCalled();
    expect(deps.actions.promote).not.toHaveBeenCalled();
  });

  it('togglePauseSelectedQueue calls the action, toasts info, and refreshes', async () => {
    const state: FakeState = { queues: [makeQueue('a')], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    (deps.actions.togglePause as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      info: 'Queue paused',
    });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();
    const callsBefore = (deps.discoverQueues as ReturnType<typeof vi.fn>).mock.calls.length;

    await store.togglePauseSelectedQueue();
    expect(deps.actions.togglePause).toHaveBeenCalledWith('a');
    expect(store.getSnapshot().toasts.map((t) => t.message)).toEqual(['Queue paused']);
    expect(deps.discoverQueues).toHaveBeenCalledTimes(callsBefore + 1);
  });

  it('togglePauseSelectedQueue toasts the failure and is a no-op without a selected queue', async () => {
    const state: FakeState = { queues: [makeQueue('a')], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    (deps.actions.togglePause as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      message: 'boom',
    });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));
    await store.refresh();

    await store.togglePauseSelectedQueue();
    expect(store.getSnapshot().toasts.map((t) => t.message)).toEqual(['boom']);

    const deps2 = createFakeDeps({ queues: [], jobs: {}, details: {} });
    const store2 = track(new DashboardStore(deps2, { redisUrl: 'redis://x' }));
    await store2.togglePauseSelectedQueue();
    expect(deps2.actions.togglePause).not.toHaveBeenCalled();
  });
});

describe('DashboardStore: navigation stack', () => {
  it('opens every queue at the Delayed status, even when it is empty', async () => {
    const state: FakeState = {
      queues: [makeQueue('email')],
      jobs: { [jobKey('email', 'waiting')]: [makeJob('waiting-1', 'send')] },
      details: {},
    };
    const store = track(new DashboardStore(createFakeDeps(state), { redisUrl: 'redis://x' }));
    await store.refresh();
    expect(store.getSnapshot().tab).toBe('active');

    store.pushJobsView();
    await flush();

    expect(store.getSnapshot().currentView).toEqual({ kind: 'jobs', queueName: 'email' });
    expect(store.getSnapshot().tab).toBe('delayed');
    expect(store.getSnapshot().visibleJobs).toEqual([]);
  });

  it('pushes the selected queue and pops back to the root without losing selection', async () => {
    const state: FakeState = {
      queues: [makeQueue('email')],
      jobs: { [jobKey('email', 'active')]: [makeJob('job-1', 'send')] },
      details: {},
    };
    const store = track(new DashboardStore(createFakeDeps(state), { redisUrl: 'redis://x' }));
    await store.refresh();

    expect(store.getSnapshot().navigationStack).toEqual([{ kind: 'queues' }]);
    store.pushJobsView();
    expect(store.getSnapshot().currentView).toEqual({ kind: 'jobs', queueName: 'email' });

    store.popView();
    expect(store.getSnapshot().navigationStack).toEqual([{ kind: 'queues' }]);
    expect(store.getSnapshot().selectedQueueName).toBe('email');
    store.popView();
    expect(store.getSnapshot().navigationStack).toEqual([{ kind: 'queues' }]);
  });

  it('popToQueues jumps to the root from the detail view and drops the detail data', async () => {
    const state: FakeState = {
      queues: [makeQueue('email')],
      jobs: { [jobKey('email', 'active')]: [makeJob('job-1', 'send')] },
      details: {
        [detailKey('email', 'job-1')]: {
          ...makeJob('job-1', 'send'),
          progress: null,
          data: { foo: 'bar' },
          returnvalue: null,
          stacktrace: [],
          opts: {},
          timestamps: { created: 0, processed: null, finished: null },
          rawProgress: null,
        },
      },
    };
    const store = track(new DashboardStore(createFakeDeps(state), { redisUrl: 'redis://x' }));
    await store.refresh();
    store.pushJobsView();
    await flush();
    store.selectTab('active');
    await flush();
    await store.openDetail();
    expect(store.getSnapshot().currentView.kind).toBe('detail');
    expect(store.getSnapshot().detail).not.toBeNull();

    store.popToQueues();

    expect(store.getSnapshot().navigationStack).toEqual([{ kind: 'queues' }]);
    expect(store.getSnapshot().detail).toBeNull();
    expect(store.getSnapshot().detailLoading).toBe(false);
    // Selection survives the jump, exactly as it does across `popView`.
    expect(store.getSnapshot().selectedQueueName).toBe('email');
    expect(store.getSnapshot().selectedJobId).toBe('job-1');
  });

  it('popToQueues collapses the whole stack in one call and is a no-op at the root', async () => {
    const state: FakeState = {
      queues: [makeQueue('email')],
      jobs: { [jobKey('email', 'active')]: [makeJob('job-1', 'send')] },
      details: {},
    };
    const store = track(new DashboardStore(createFakeDeps(state), { redisUrl: 'redis://x' }));
    await store.refresh();
    store.pushJobsView();
    await flush();
    expect(store.getSnapshot().currentView.kind).toBe('jobs');

    store.popToQueues();
    expect(store.getSnapshot().navigationStack).toEqual([{ kind: 'queues' }]);

    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.popToQueues();
    expect(store.getSnapshot().navigationStack).toEqual([{ kind: 'queues' }]);
    expect(notified).toBe(0);
  });
});

describe('DashboardStore: toasts', () => {
  it('dismissToast removes a toast early and is a no-op for an unknown id', async () => {
    const deps = createFakeDeps({ queues: [], jobs: {}, details: {} });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x', toastDurationMs: 1000 }));

    store.pushToast('hello');
    const id = store.getSnapshot().toasts[0].id;
    store.dismissToast(id);
    expect(store.getSnapshot().toasts).toHaveLength(0);

    expect(() => store.dismissToast(id)).not.toThrow();
    expect(() => store.dismissToast(999)).not.toThrow();
  });
});

describe('DashboardStore: snapshot/subscribe', () => {
  it('returns a stable snapshot reference until a real state change occurs', () => {
    const deps = createFakeDeps({ queues: [], jobs: {}, details: {} });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    const snap1 = store.getSnapshot();
    const snap2 = store.getSnapshot();
    expect(snap1).toBe(snap2);

    store.setFocus('jobs');
    const snap3 = store.getSnapshot();
    expect(snap3).not.toBe(snap1);
  });

  it('notifies subscribers on state change and stops after unsubscribe', () => {
    const deps = createFakeDeps({ queues: [], jobs: {}, details: {} });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://x' }));

    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });

    store.setFocus('jobs');
    expect(calls).toBe(1);

    unsubscribe();
    store.setFocus('sidebar');
    expect(calls).toBe(1);
  });
});

describe('DashboardStore: dispose', () => {
  it('stops polling and clears toast timers; is idempotent', async () => {
    const deps = createFakeDeps({ queues: [makeQueue('a')], jobs: {}, details: {} });
    const store = new DashboardStore(deps, {
      redisUrl: 'redis://x',
      pollIntervalMs: 3000,
      toastDurationMs: 5000,
    });

    store.startPolling();
    store.pushToast('hello');
    const before = vi.getTimerCount();
    expect(before).toBeGreaterThan(0);

    store.dispose();
    expect(vi.getTimerCount()).toBeLessThan(before);

    expect(() => store.dispose()).not.toThrow();

    // refresh() after dispose is a no-op (doesn't throw, doesn't call deps)
    await store.refresh();
  });

  it('a pending refresh timeout timer is cleared by dispose too', async () => {
    const deps = createFakeDeps({ queues: [makeQueue('a')], jobs: {}, details: {} });
    (deps.fetchJobPage as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise(() => {}));
    const store = new DashboardStore(deps, { redisUrl: 'redis://x', refreshTimeoutMs: 5000 });

    void store.refresh();
    await flush();
    const before = vi.getTimerCount();
    expect(before).toBeGreaterThan(0);

    store.dispose();
    expect(vi.getTimerCount()).toBeLessThan(before);
  });
});

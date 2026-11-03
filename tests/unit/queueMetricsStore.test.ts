import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardStore, type StoreDeps } from '../../src/core/store.js';
import type { ActionResult, JobStatus, QueueInfo } from '../../src/core/types.js';

const zero = (p: Partial<Record<JobStatus, number>> = {}): Record<JobStatus, number> => ({
  delayed: 0,
  waiting: 0,
  active: 0,
  failed: 0,
  completed: 0,
  ...p,
});

interface State {
  queues: QueueInfo[];
  counts: Record<string, Record<JobStatus, number>>;
  failCounts: Set<string>;
}

function makeDeps(state: State, clock: { now: number }): StoreDeps {
  return {
    discoverQueues: vi.fn(async () => state.queues),
    fetchQueueCounts: vi.fn(async (name: string) => {
      if (state.failCounts.has(name)) throw new Error('boom');
      return state.counts[name] ?? zero();
    }),
    fetchJobPage: vi.fn(async (name: string, _status: JobStatus, page: number) => ({
      jobs: [],
      totalCount: 0,
      page,
      pageCount: 1,
      counts: state.counts[name] ?? zero(),
    })),
    getJobDetail: vi.fn(async () => null),
    fetchSchedulerPage: vi.fn(async () => ({
      schedulers: [],
      totalCount: 0,
      page: 0,
      pageCount: 1,
    })),
    getSchedulerDetail: vi.fn(async () => null),
    actions: {
      retry: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
      delete: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
      promote: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
      duplicate: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
      togglePause: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
      drain: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
      retryAll: vi.fn(async () => ({ matched: 0, retried: 0, errored: 0, errors: [] })),
    },
    syncRegistry: vi.fn(async () => {}),
    now: () => clock.now,
  };
}

const stores: DashboardStore[] = [];

async function setup() {
  const clock = { now: 1_000_000 };
  const state: State = {
    queues: ['alpha', 'beta'].map((name) => ({ name, isPaused: false })),
    counts: {
      alpha: zero({ waiting: 2, failed: 1, completed: 100 }),
      beta: zero({ delayed: 3, active: 1, failed: 4, completed: 50 }),
    },
    failCounts: new Set(),
  };
  const deps = makeDeps(state, clock);
  const store = new DashboardStore(deps, { redisUrl: 'redis://x' });
  stores.push(store);
  await store.refresh();
  return { state, deps, store, clock };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
  vi.useRealTimers();
});

describe('queue totals', () => {
  it('starts as all zeros before anything is fetched', () => {
    const clock = { now: 0 };
    const state: State = { queues: [], counts: {}, failCounts: new Set() };
    const store = new DashboardStore(makeDeps(state, clock), { redisUrl: 'redis://x' });
    stores.push(store);
    expect(store.getSnapshot().queueTotals).toEqual(zero());
    expect(store.getSnapshot().throughput).toBeNull();
  });

  it('sums the counts of every discovered queue', async () => {
    const { store } = await setup();
    expect(store.getSnapshot().queueTotals).toEqual({
      delayed: 3,
      waiting: 2,
      active: 1,
      failed: 5,
      completed: 150,
    });
  });

  it('ignores the name filter: totals are across all queues', async () => {
    const { store } = await setup();
    store.openQueueFilter();
    store.setQueueFilterQuery('alp');
    expect(store.getSnapshot().visibleQueues.map((q) => q.name)).toEqual(['alpha']);
    expect(store.getSnapshot().queueTotals.completed).toBe(150);
  });

  it('drops a queue that is no longer discovered', async () => {
    const { store, state } = await setup();
    state.queues = state.queues.filter((q) => q.name !== 'beta');
    await store.refresh();
    expect(store.getSnapshot().queueTotals).toEqual(
      zero({ waiting: 2, failed: 1, completed: 100 }),
    );
  });
});

describe('throughput', () => {
  it('is null after the first refresh, then a per-minute rate after the second', async () => {
    const { store, state, clock } = await setup();
    expect(store.getSnapshot().throughput).toBeNull();

    clock.now += 30_000;
    state.counts.alpha = zero({ waiting: 2, failed: 2, completed: 110 });
    state.counts.beta = zero({ delayed: 3, active: 1, failed: 4, completed: 55 });
    await store.refresh();

    expect(store.getSnapshot().throughput).toEqual({ completedPerMin: 30, failedPerMin: 2 });
  });

  it('reads 0, not negative, after a queue is cleaned, and recovers on the next poll', async () => {
    const { store, state, clock } = await setup();

    clock.now += 60_000;
    state.counts.alpha = zero({ waiting: 2 });
    await store.refresh();
    expect(store.getSnapshot().throughput).toEqual({ completedPerMin: 0, failedPerMin: 0 });

    clock.now += 60_000;
    state.counts.alpha = zero({ waiting: 2, completed: 20 });
    await store.refresh();
    // Window 60s..120s: 20 completed on alpha, beta flat.
    expect(store.getSnapshot().throughput?.completedPerMin).toBe(20);
  });

  it("doesn't spike when a new queue is discovered", async () => {
    const { store, state, clock } = await setup();
    clock.now += 60_000;
    state.queues = [...state.queues, { name: 'gamma', isPaused: false }];
    state.counts.gamma = zero({ completed: 10_000 });
    await store.refresh();
    expect(store.getSnapshot().throughput?.completedPerMin).toBe(0);
    expect(store.getSnapshot().queueTotals.completed).toBe(10_150);
  });

  it("keeps a queue's last-known counts when its count fetch fails, then catches up", async () => {
    const { store, state, clock } = await setup();
    clock.now += 30_000;
    state.failCounts.add('beta');
    state.counts.beta = zero({ completed: 80 });
    await store.refresh();
    expect(store.getSnapshot().throughput?.completedPerMin).toBe(0);

    clock.now += 30_000;
    state.failCounts.clear();
    await store.refresh();
    // 30 completions on beta over the whole minute.
    expect(store.getSnapshot().throughput?.completedPerMin).toBe(30);
  });

  it('is computed from the counts the store already fetches, with no extra calls', async () => {
    const { store, deps, clock } = await setup();
    const discover = vi.mocked(deps.discoverQueues).mock.calls.length;
    const counts = vi.mocked(deps.fetchQueueCounts ?? vi.fn()).mock.calls.length;
    clock.now += 3000;
    await store.refresh();
    expect(vi.mocked(deps.discoverQueues).mock.calls.length).toBe(discover + 1);
    // One count fetch per discovered queue per refresh.
    expect(vi.mocked(deps.fetchQueueCounts ?? vi.fn()).mock.calls.length).toBe(counts + 2);
  });
});

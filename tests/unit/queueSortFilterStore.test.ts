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
}

function makeDeps(state: State): StoreDeps {
  return {
    discoverQueues: vi.fn(async () => state.queues),
    fetchQueueCounts: vi.fn(async (name: string) => state.counts[name] ?? zero()),
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
      remove: vi.fn(async () => ({ ok: true as const })),
    },
    syncRegistry: vi.fn(async () => {}),
  };
}

const stores: DashboardStore[] = [];

async function setup(names = ['alpha', 'beta', 'gamma', 'Delta']) {
  const state: State = {
    queues: names.map((name) => ({ name, isPaused: false })),
    counts: {
      alpha: zero({ failed: 1 }),
      beta: zero({ failed: 9, waiting: 2 }),
      gamma: zero({ failed: 5, waiting: 8 }),
      Delta: zero({ completed: 50 }),
    },
  };
  const deps = makeDeps(state);
  const store = new DashboardStore(deps, { redisUrl: 'redis://x' });
  stores.push(store);
  await store.refresh();
  return { state, deps, store };
}

const visible = (store: DashboardStore) => store.getSnapshot().visibleQueues.map((x) => x.name);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
  vi.useRealTimers();
});

describe('queue sort', () => {
  it('defaults to name and cycles in order, wrapping', async () => {
    const { store } = await setup();
    const seen = [store.getSnapshot().queueSort];
    for (let i = 0; i < 6; i++) {
      store.cycleQueueSort();
      seen.push(store.getSnapshot().queueSort);
    }
    expect(seen).toEqual(['name', 'total', 'failed', 'waiting', 'active', 'delayed', 'name']);
  });

  it('sorts visibleQueues but keeps queues in discovery order', async () => {
    const { store } = await setup();
    expect(visible(store)).toEqual(['alpha', 'beta', 'Delta', 'gamma']);
    store.cycleQueueSort(); // total
    expect(visible(store)).toEqual(['Delta', 'gamma', 'beta', 'alpha']);
    expect(store.getSnapshot().queues.map((x) => x.name)).toEqual([
      'alpha',
      'beta',
      'gamma',
      'Delta',
    ]);
  });

  it('does not refresh or fetch, and keeps the selection', async () => {
    const { store, deps } = await setup();
    store.selectQueue('gamma');
    await vi.advanceTimersByTimeAsync(0);
    const discoverCalls = vi.mocked(deps.discoverQueues).mock.calls.length;
    const pageCalls = vi.mocked(deps.fetchJobPage).mock.calls.length;
    store.cycleQueueSort();
    store.cycleQueueSort();
    expect(store.getSnapshot().selectedQueueName).toBe('gamma');
    expect(deps.discoverQueues).toHaveBeenCalledTimes(discoverCalls);
    expect(deps.fetchJobPage).toHaveBeenCalledTimes(pageCalls);
  });

  it('keeps the selection across a refresh where counts change the order', async () => {
    const { store, state } = await setup();
    store.cycleQueueSort();
    store.cycleQueueSort(); // failed
    expect(visible(store)).toEqual(['beta', 'gamma', 'alpha', 'Delta']);
    store.selectQueue('gamma');
    await vi.advanceTimersByTimeAsync(0);
    state.counts.alpha = zero({ failed: 100 });
    await store.refresh();
    expect(visible(store)[0]).toBe('alpha');
    expect(store.getSnapshot().selectedQueueName).toBe('gamma');
  });
});

describe('queue filter', () => {
  it('filters case-insensitively and does not trigger refreshes when selection stays', async () => {
    const { store, deps } = await setup();
    store.openQueueFilter();
    const pageCalls = vi.mocked(deps.fetchJobPage).mock.calls.length;
    store.setQueueFilterQuery('A');
    expect(visible(store)).toEqual(['alpha', 'beta', 'Delta', 'gamma']);
    store.setQueueFilterQuery('DEL');
    expect(visible(store)).toEqual(['Delta']);
    expect(store.getSnapshot().queueFilter).toEqual({ active: true, query: 'DEL' });
    store.setQueueFilterQuery('al');
    expect(visible(store)).toEqual(['alpha']);
    expect(store.getSnapshot().selectedQueueName).toBe('alpha');
    expect(deps.fetchJobPage).toHaveBeenCalledTimes(pageCalls);
  });

  it('moves the selection to the first match, to null when none match, and restores on Esc', async () => {
    const { store } = await setup();
    store.openQueueFilter();
    store.setQueueFilterQuery('gam');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().selectedQueueName).toBe('gamma');

    store.setQueueFilterQuery('zzz');
    const snap = store.getSnapshot();
    expect(snap.visibleQueues).toEqual([]);
    expect(snap.selectedQueueName).toBeNull();
    expect(snap.jobPage).toBeNull();
    expect(snap.selectedJobId).toBeNull();
    expect(snap.jobsLoading).toBe(false);

    store.closeQueueFilter();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().queueFilter).toEqual({ active: false, query: '' });
    expect(store.getSnapshot().selectedQueueName).toBe('alpha');
  });

  it('keeps the current selection when the filter is cleared', async () => {
    const { store } = await setup();
    store.openQueueFilter();
    store.setQueueFilterQuery('gam');
    store.closeQueueFilter();
    expect(store.getSnapshot().selectedQueueName).toBe('gamma');
  });

  it('only opens on the queue view, and Enter keeps the query', async () => {
    const { store } = await setup();
    store.pushJobsView();
    store.openQueueFilter();
    expect(store.getSnapshot().queueFilter.active).toBe(false);
    store.popToQueues();
    store.openQueueFilter();
    store.setQueueFilterQuery('be');
    store.acceptQueueFilter();
    expect(store.getSnapshot().queueFilter).toEqual({ active: false, query: 'be' });
    store.acceptQueueFilter();
    store.openQueueFilter();
    store.openQueueFilter();
    expect(store.getSnapshot().queueFilter.query).toBe('be');
    store.closeQueueFilter();
    store.closeQueueFilter(); // no-op when already closed and empty
    expect(store.getSnapshot().queueFilter.query).toBe('');
  });

  it('survives selectQueue, push/pop and popToQueues', async () => {
    const { store } = await setup();
    store.openQueueFilter();
    store.setQueueFilterQuery('a');
    store.acceptQueueFilter();
    store.selectQueue(1);
    expect(store.getSnapshot().queueFilter.query).toBe('a');
    store.pushJobsView();
    expect(store.getSnapshot().queueFilter.query).toBe('a');
    store.popView();
    expect(store.getSnapshot().queueFilter.query).toBe('a');
    store.pushJobsView();
    store.popToQueues();
    expect(store.getSnapshot().queueFilter.query).toBe('a');
  });

  it('makes Enter, p and D no-ops with no visible selection', async () => {
    const { store, deps } = await setup();
    store.openQueueFilter();
    store.setQueueFilterQuery('zzz');
    store.pushJobsView();
    store.requestDrain();
    await store.togglePauseSelectedQueue();
    const snap = store.getSnapshot();
    expect(snap.currentView.kind).toBe('queues');
    expect(snap.confirmDrain).toBe(false);
    expect(deps.actions.togglePause).not.toHaveBeenCalled();
  });

  it('never acts on a queue the filter hides', async () => {
    const { store, deps } = await setup();
    store.openQueueFilter();
    store.setQueueFilterQuery('gam');
    await store.togglePauseSelectedQueue();
    expect(deps.actions.togglePause).toHaveBeenCalledWith('gamma');
  });
});

describe('queue selection walk', () => {
  it('walks the visible order, clamped', async () => {
    const { store } = await setup();
    store.cycleQueueSort(); // total: Delta, gamma, beta, alpha
    store.selectQueue(0);
    expect(store.getSnapshot().selectedQueueName).toBe('Delta');
    store.selectPrevQueue();
    expect(store.getSnapshot().selectedQueueName).toBe('Delta');
    store.selectNextQueue();
    store.selectNextQueue();
    expect(store.getSnapshot().selectedQueueName).toBe('beta');
    store.selectNextQueue();
    store.selectNextQueue();
    expect(store.getSnapshot().selectedQueueName).toBe('alpha');
  });

  it('ignores hidden names and out-of-range indexes, and walks nothing when empty', async () => {
    const { store } = await setup();
    store.openQueueFilter();
    store.setQueueFilterQuery('gam');
    store.selectQueue('alpha');
    store.selectQueue(5);
    expect(store.getSnapshot().selectedQueueName).toBe('gamma');
    store.setQueueFilterQuery('zzz');
    store.selectNextQueue();
    store.selectPrevQueue();
    expect(store.getSnapshot().selectedQueueName).toBeNull();
  });

  it('clamps a vanished selection by its old index in the visible order', async () => {
    const { store, state } = await setup();
    store.cycleQueueSort(); // total: Delta, gamma, beta, alpha
    store.selectQueue('beta'); // visible index 2
    await vi.advanceTimersByTimeAsync(0);
    state.queues = state.queues.filter((x) => x.name !== 'beta');
    await store.refresh();
    // new visible: Delta, gamma, alpha -> index 2 = alpha (discovery order would give Delta)
    expect(store.getSnapshot().selectedQueueName).toBe('alpha');
  });

  it('selects null when everything disappears and recovers the first visible after', async () => {
    const { store, state } = await setup();
    const all = state.queues;
    state.queues = [];
    await store.refresh();
    expect(store.getSnapshot().selectedQueueName).toBeNull();
    state.queues = all;
    await store.refresh();
    expect(store.getSnapshot().selectedQueueName).toBe('alpha');
  });
});

describe('queue filter during a reconnect', () => {
  it('can be opened while the connection is reconnecting (the list stays on screen)', async () => {
    const { store } = await setup();
    store.onConnectionStatus({ state: 'connecting' });
    store.openQueueFilter();
    expect(store.getSnapshot().queueFilter.active).toBe(true);
  });
});

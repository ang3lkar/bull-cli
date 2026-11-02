import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardStore, type StoreDeps } from '../../src/core/store.js';
import type { ActionResult, JobStatus, QueueInfo } from '../../src/core/types.js';

// Edge-case probes for the queue sort/filter (issue #8). Kept separate from
// queueSortFilterStore.test.ts so the implementer's file is left untouched.

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

describe('edge: filter hides the selection, then queue actions', () => {
  it('D acts on the first match, never on the queue the filter hid', async () => {
    const { store, deps } = await setup();
    expect(store.getSnapshot().selectedQueueName).toBe('alpha');
    store.openQueueFilter();
    store.setQueueFilterQuery('gam');
    expect(store.getSnapshot().selectedQueueName).toBe('gamma');
    store.requestDrain();
    expect(store.getSnapshot().confirmDrain).toBe(true);
    await store.confirmDrain();
    expect(deps.actions.drain).toHaveBeenCalledWith('gamma');
    expect(deps.actions.drain).not.toHaveBeenCalledWith('alpha');
  });

  it('Enter enters the first match, not the hidden queue', async () => {
    const { store } = await setup();
    store.openQueueFilter();
    store.setQueueFilterQuery('del');
    store.pushJobsView();
    const top = store.getSnapshot().currentView;
    expect(top).toEqual({ kind: 'jobs', queueName: 'Delta' });
  });

  it('p toggles the first match after the selection is hidden', async () => {
    const { store, deps } = await setup();
    store.openQueueFilter();
    store.setQueueFilterQuery('bet');
    await store.togglePauseSelectedQueue();
    expect(deps.actions.togglePause).toHaveBeenCalledWith('beta');
    expect(deps.actions.togglePause).not.toHaveBeenCalledWith('alpha');
  });
});

describe('edge: filter matches nothing, then refresh', () => {
  it('keeps selection null, clears the job page, and does not error', async () => {
    const { store } = await setup();
    store.openQueueFilter();
    store.setQueueFilterQuery('zzz');
    await store.refresh();
    const snap = store.getSnapshot();
    expect(snap.visibleQueues).toEqual([]);
    expect(snap.selectedQueueName).toBeNull();
    expect(snap.jobPage).toBeNull();
    expect(snap.selectedJobId).toBeNull();
    expect(snap.connection.state).toBe('ready');
    expect(snap.queues.length).toBe(4);
  });

  it('selects the first queue that starts matching on a later refresh', async () => {
    const { store, state } = await setup();
    store.openQueueFilter();
    store.setQueueFilterQuery('zzz');
    await vi.advanceTimersByTimeAsync(0); // let the refresh the null selection starts settle
    state.queues = [...state.queues, { name: 'zzz-new', isPaused: false }];
    await store.refresh();
    expect(store.getSnapshot().selectedQueueName).toBe('zzz-new');
    expect(visible(store)).toEqual(['zzz-new']);
  });
});

describe('edge: queue disappears on refresh while sorted by a count', () => {
  it('clamps by the old index in the sorted+filtered order, not discovery order', async () => {
    const { store, state } = await setup();
    store.cycleQueueSort();
    store.cycleQueueSort(); // failed: beta(9), gamma(5), alpha(1), Delta(0)
    store.openQueueFilter();
    store.setQueueFilterQuery('a'); // every name contains 'a'
    store.acceptQueueFilter();
    store.selectQueue('gamma'); // visible index 1
    await vi.advanceTimersByTimeAsync(0);
    state.queues = state.queues.filter((q) => q.name !== 'gamma');
    await store.refresh();
    // new visible: beta, alpha, Delta -> index 1 is alpha (discovery order would give beta)
    expect(visible(store)).toEqual(['beta', 'alpha', 'Delta']);
    expect(store.getSnapshot().selectedQueueName).toBe('alpha');
  });
});

describe('edge: job search still behaves as before alongside the queue filter', () => {
  it('Enter keeps and Esc clears the job search, leaving the queue filter alone', async () => {
    const { store } = await setup();
    store.openQueueFilter();
    store.setQueueFilterQuery('be');
    store.acceptQueueFilter();
    store.pushJobsView();
    store.openSearch();
    store.setSearchQuery('job-1');
    store.acceptSearch();
    expect(store.getSnapshot().search).toEqual({ active: false, query: 'job-1' });
    store.closeSearch();
    expect(store.getSnapshot().search.query).toBe('');
    expect(store.getSnapshot().queueFilter).toEqual({ active: false, query: 'be' });
  });

  it('a job search does not open or alter the queue filter', async () => {
    const { store } = await setup();
    store.openSearch();
    expect(store.getSnapshot().queueFilter.active).toBe(false);
    store.setSearchQuery('x');
    expect(store.getSnapshot().queueFilter.query).toBe('');
  });
});

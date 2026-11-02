import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardStore, type StoreDeps } from '../../src/core/store.js';
import type {
  ActionResult,
  JobDetail,
  JobPage,
  JobStatus,
  SchedulerDetail,
  SchedulerPage,
  SchedulerSummary,
} from '../../src/core/types.js';

// --- fixtures & fakes ------------------------------------------------

const ZERO_COUNTS: Record<JobStatus, number> = {
  active: 0,
  waiting: 0,
  completed: 0,
  failed: 0,
  delayed: 0,
};

function makeScheduler(key: string, overrides: Partial<SchedulerSummary> = {}): SchedulerSummary {
  return {
    key,
    name: `${key}-job`,
    pattern: null,
    every: 60_000,
    tz: null,
    next: 1000,
    iterationCount: 0,
    limit: null,
    ...overrides,
  };
}

function makeSchedulerDetail(
  key: string,
  overrides: Partial<SchedulerDetail> = {},
): SchedulerDetail {
  return {
    ...makeScheduler(key),
    startDate: null,
    endDate: null,
    offset: null,
    template: { data: { k: key }, opts: {} },
    nextJobId: `repeat:${key}:1000`,
    ...overrides,
  };
}

function makeJobDetail(id: string): JobDetail {
  return {
    id,
    name: 'job',
    attemptsMade: 0,
    timestamp: 0,
    progress: null,
    data: {},
    returnvalue: undefined,
    stacktrace: [],
    opts: {},
    timestamps: { created: 0, processed: null, finished: null },
    rawProgress: null,
    state: 'delayed',
    failedReason: null,
  };
}

interface FakeState {
  schedulers: SchedulerSummary[];
  schedulerDetails: Record<string, SchedulerDetail | null>;
  jobDetails: Record<string, JobDetail | null>;
}

function paginate(items: SchedulerSummary[], page: number, size = 10): SchedulerPage {
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const clamped = Math.min(Math.max(page, 0), pageCount - 1);
  return {
    schedulers: items.slice(clamped * size, clamped * size + size),
    totalCount: items.length,
    page: clamped,
    pageCount,
  };
}

function createDeps(state: FakeState): StoreDeps {
  return {
    discoverQueues: vi.fn(async () => [{ name: 'q', isPaused: false }]),
    fetchQueueCounts: vi.fn(async () => ZERO_COUNTS),
    fetchJobPage: vi.fn(
      async (): Promise<JobPage> => ({
        jobs: [],
        totalCount: 0,
        page: 0,
        pageCount: 1,
        counts: ZERO_COUNTS,
      }),
    ),
    getJobDetail: vi.fn(async (_q: string, id: string) => state.jobDetails[id] ?? null),
    fetchSchedulerPage: vi.fn(async (_q: string, page: number, size?: number) =>
      paginate(state.schedulers, page, size),
    ),
    fetchSchedulerCount: vi.fn(async () => state.schedulers.length),
    getSchedulerDetail: vi.fn(
      async (_q: string, key: string) => state.schedulerDetails[key] ?? null,
    ),
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

const stores: DashboardStore[] = [];

function emptyState(overrides: Partial<FakeState> = {}): FakeState {
  return { schedulers: [], schedulerDetails: {}, jobDetails: {}, ...overrides };
}

async function setup(state: FakeState, extraDeps: Partial<StoreDeps> = {}) {
  const deps = { ...createDeps(state), ...extraDeps };
  const store = new DashboardStore(deps, { redisUrl: 'redis://x' });
  stores.push(store);
  await store.refresh();
  return { deps, store };
}

/** Enters the queue's job list and switches to the Schedulers tab. */
async function openSchedulersTab(store: DashboardStore): Promise<void> {
  store.pushJobsView();
  await flush();
  store.selectTab('schedulers');
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.dispose();
  }
  vi.useRealTimers();
});

// --- tests -------------------------------------------------------------

describe('Schedulers tab: switching', () => {
  it('is the sixth tab, reached with key 6 (index) or by name', async () => {
    const { store } = await setup(emptyState());
    store.pushJobsView();
    await flush();

    store.selectTab(6);
    await flush();
    expect(store.getSnapshot().tab).toBe('schedulers');

    store.selectTab(1);
    await flush();
    expect(store.getSnapshot().tab).toBe('delayed');

    store.selectTab('schedulers');
    await flush();
    expect(store.getSnapshot().tab).toBe('schedulers');
    expect(store.getSnapshot().jobPage).toBeNull();
  });

  it('is reachable with → from Completed and clamps at both ends', async () => {
    const { store } = await setup(emptyState());
    store.pushJobsView();
    await flush();
    store.selectTab('completed');
    await flush();

    store.selectAdjacentTab(1);
    await flush();
    expect(store.getSnapshot().tab).toBe('schedulers');

    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.selectAdjacentTab(1);
    expect(store.getSnapshot().tab).toBe('schedulers');
    expect(notified).toBe(0);

    store.selectAdjacentTab(-1);
    await flush();
    expect(store.getSnapshot().tab).toBe('completed');
  });

  it('ignores an out-of-range tab index', async () => {
    const { store } = await setup(emptyState());
    store.pushJobsView();
    await flush();
    store.selectTab(7);
    expect(store.getSnapshot().tab).toBe('delayed');
  });

  it('fetches a scheduler page instead of a job page on that tab', async () => {
    const state = emptyState({ schedulers: [makeScheduler('a'), makeScheduler('b')] });
    const { deps, store } = await setup(state);
    store.pushJobsView();
    await flush();
    vi.mocked(deps.fetchJobPage).mockClear();

    store.selectTab('schedulers');
    await flush();

    expect(deps.fetchJobPage).not.toHaveBeenCalled();
    expect(deps.fetchSchedulerPage).toHaveBeenCalledWith('q', 0, 10);
    const snap = store.getSnapshot();
    expect(snap.schedulerPage?.schedulers.map((s) => s.key)).toEqual(['a', 'b']);
    expect(snap.selectedSchedulerKey).toBe('a');
    expect(snap.schedulerCount).toBe(2);
    expect(snap.jobsLoading).toBe(false);
  });

  it('reports jobsLoading until the first scheduler page lands', async () => {
    const gate = deferred<SchedulerPage>();
    const { deps, store } = await setup(emptyState());
    store.pushJobsView();
    await flush();
    vi.mocked(deps.fetchSchedulerPage).mockReturnValueOnce(gate.promise);

    store.selectTab('schedulers');
    await flush();
    expect(store.getSnapshot().jobsLoading).toBe(true);
    expect(store.getSnapshot().schedulerPage).toBeNull();

    gate.resolve(paginate([makeScheduler('a')], 0));
    await flush();
    expect(store.getSnapshot().jobsLoading).toBe(false);
    expect(store.getSnapshot().schedulerPage?.schedulers).toHaveLength(1);
  });

  it('drops the scheduler page again when leaving the tab', async () => {
    const { store } = await setup(emptyState({ schedulers: [makeScheduler('a')] }));
    await openSchedulersTab(store);
    store.selectTab('delayed');
    await flush();
    expect(store.getSnapshot().schedulerPage).toBeNull();
    expect(store.getSnapshot().selectedSchedulerKey).toBeNull();
  });
});

describe('Schedulers tab: count', () => {
  it('keeps the count fresh from job-status tabs with one extra count fetch', async () => {
    const state = emptyState({ schedulers: [makeScheduler('a'), makeScheduler('b')] });
    const { deps, store } = await setup(state);
    store.pushJobsView();
    await flush();

    expect(deps.fetchSchedulerCount).toHaveBeenCalledWith('q');
    expect(store.getSnapshot().schedulerCount).toBe(2);

    state.schedulers.push(makeScheduler('c'));
    await store.refresh();
    expect(store.getSnapshot().schedulerCount).toBe(3);
  });

  it('is null before it is known and when no queue is selected', async () => {
    const deps = createDeps(emptyState());
    deps.discoverQueues = vi.fn(async () => []);
    const store = new DashboardStore(deps, { redisUrl: 'redis://x' });
    stores.push(store);
    expect(store.getSnapshot().schedulerCount).toBeNull();
    await store.refresh();
    expect(store.getSnapshot().schedulerCount).toBeNull();
    expect(store.getSnapshot().schedulerPage).toBeNull();
  });

  it('does not fail the job page when the count fetch fails', async () => {
    const { deps, store } = await setup(emptyState({ schedulers: [makeScheduler('a')] }));
    vi.mocked(
      deps.fetchSchedulerCount as NonNullable<StoreDeps['fetchSchedulerCount']>,
    ).mockRejectedValue(new Error('boom'));
    store.pushJobsView();
    await flush();
    await store.refresh();

    expect(store.getSnapshot().jobPage).not.toBeNull();
    expect(store.getSnapshot().toasts).toEqual([]);
    expect(store.getSnapshot().connection.state).toBe('ready');
  });

  it('works when the dep does not provide a count fetch', async () => {
    const deps = createDeps(emptyState());
    deps.fetchSchedulerCount = undefined;
    const store = new DashboardStore(deps, { redisUrl: 'redis://x' });
    stores.push(store);
    await store.refresh();
    store.pushJobsView();
    await flush();
    expect(store.getSnapshot().jobPage).not.toBeNull();
    expect(store.getSnapshot().schedulerCount).toBeNull();
  });
});

describe('Schedulers tab: paging and selection', () => {
  const many = Array.from({ length: 25 }, (_, i) =>
    makeScheduler(`s${String(i).padStart(2, '0')}`),
  );

  it('pages forwards and backwards, clamped at the ends', async () => {
    const { deps, store } = await setup(emptyState({ schedulers: many }));
    await openSchedulersTab(store);
    expect(store.getSnapshot().schedulerPage?.pageCount).toBe(3);

    store.prevPage();
    expect(store.getSnapshot().page).toBe(0);

    store.nextPage();
    await flush();
    expect(deps.fetchSchedulerPage).toHaveBeenLastCalledWith('q', 1, 10);
    expect(store.getSnapshot().page).toBe(1);
    expect(store.getSnapshot().selectedSchedulerKey).toBe('s10');

    store.nextPage();
    await flush();
    store.nextPage();
    await flush();
    expect(store.getSnapshot().page).toBe(2);
    expect(store.getSnapshot().schedulerPage?.schedulers).toHaveLength(5);

    store.prevPage();
    await flush();
    expect(store.getSnapshot().page).toBe(1);
  });

  it('does not page before the first scheduler page has loaded', async () => {
    const { deps, store } = await setup(emptyState({ schedulers: many }));
    store.pushJobsView();
    await flush();
    vi.mocked(deps.fetchSchedulerPage).mockReturnValueOnce(new Promise(() => {}));
    store.selectTab('schedulers');
    await flush();
    store.nextPage();
    store.prevPage();
    expect(store.getSnapshot().page).toBe(0);
  });

  it('moves the selection with next/prev, clamped', async () => {
    const { store } = await setup(emptyState({ schedulers: many.slice(0, 3) }));
    await openSchedulersTab(store);

    store.selectPrevScheduler();
    expect(store.getSnapshot().selectedSchedulerKey).toBe('s00');
    store.selectNextScheduler();
    store.selectNextScheduler();
    store.selectNextScheduler();
    expect(store.getSnapshot().selectedSchedulerKey).toBe('s02');
    store.selectPrevScheduler();
    expect(store.getSnapshot().selectedSchedulerKey).toBe('s01');
  });

  it('starts from the first row when nothing is selected, and ignores empty or other tabs', async () => {
    const state = emptyState({ schedulers: many.slice(0, 2) });
    const { store } = await setup(state);
    store.pushJobsView();
    await flush();
    // Not on the Schedulers tab: inert.
    store.selectNextScheduler();
    expect(store.getSnapshot().selectedSchedulerKey).toBeNull();

    store.selectTab('schedulers');
    await flush();
    state.schedulers.length = 0;
    await store.refresh();
    store.selectNextScheduler();
    expect(store.getSnapshot().selectedSchedulerKey).toBeNull();
  });

  it('preserves the selection by key across a refresh that reorders rows', async () => {
    const state = emptyState({
      schedulers: [makeScheduler('a'), makeScheduler('b'), makeScheduler('c')],
    });
    const { store } = await setup(state);
    await openSchedulersTab(store);
    store.selectNextScheduler();
    expect(store.getSnapshot().selectedSchedulerKey).toBe('b');

    state.schedulers = [makeScheduler('c'), makeScheduler('b'), makeScheduler('a')];
    await store.refresh();
    expect(store.getSnapshot().selectedSchedulerKey).toBe('b');
  });

  it('clamps the selection to the nearest row when its scheduler disappears', async () => {
    const state = emptyState({
      schedulers: [makeScheduler('a'), makeScheduler('b'), makeScheduler('c')],
    });
    const { store } = await setup(state);
    await openSchedulersTab(store);
    store.selectNextScheduler();
    store.selectNextScheduler();
    expect(store.getSnapshot().selectedSchedulerKey).toBe('c');

    state.schedulers = [makeScheduler('a'), makeScheduler('b')];
    await store.refresh();
    expect(store.getSnapshot().selectedSchedulerKey).toBe('b');

    state.schedulers = [];
    await store.refresh();
    expect(store.getSnapshot().selectedSchedulerKey).toBeNull();
  });
});

describe('Schedulers tab: stale results', () => {
  it('discards a slow scheduler page that a tab switch has superseded', async () => {
    const gate = deferred<SchedulerPage>();
    const { deps, store } = await setup(emptyState({ schedulers: [makeScheduler('a')] }));
    store.pushJobsView();
    await flush();
    vi.mocked(deps.fetchSchedulerPage).mockReturnValueOnce(gate.promise);

    store.selectTab('schedulers');
    await flush();
    store.selectTab('failed');
    await flush();

    gate.resolve(paginate([makeScheduler('stale')], 0));
    await flush();
    expect(store.getSnapshot().tab).toBe('failed');
    expect(store.getSnapshot().schedulerPage).toBeNull();
    expect(store.getSnapshot().jobPage).not.toBeNull();
  });

  it('discards a slow scheduler page that selection movement has superseded', async () => {
    const state = emptyState({ schedulers: [makeScheduler('a'), makeScheduler('b')] });
    const { deps, store } = await setup(state);
    await openSchedulersTab(store);
    const gate = deferred<SchedulerPage>();
    vi.mocked(deps.fetchSchedulerPage).mockReturnValueOnce(gate.promise);

    const refreshing = store.refresh();
    await flush();
    store.selectNextScheduler();
    gate.resolve(paginate([makeScheduler('x')], 0));
    await refreshing;
    await flush();

    expect(store.getSnapshot().selectedSchedulerKey).toBe('b');
    expect(store.getSnapshot().schedulerPage?.schedulers.map((s) => s.key)).toEqual(['a', 'b']);
  });

  it('toasts once and empties the table when the scheduler page fails to load', async () => {
    const { deps, store } = await setup(emptyState({ schedulers: [makeScheduler('a')] }));
    store.pushJobsView();
    await flush();
    vi.mocked(deps.fetchSchedulerPage).mockRejectedValue(new Error('no such queue'));
    store.selectTab('schedulers');
    await flush();

    const snap = store.getSnapshot();
    expect(snap.schedulerPage).toBeNull();
    expect(snap.jobsLoading).toBe(false);
    expect(snap.toasts.map((t) => t.message)).toEqual(['Could not load queue "q": no such queue']);
  });
});

describe('Scheduler detail', () => {
  function stateWithDetail(): FakeState {
    return emptyState({
      schedulers: [makeScheduler('a'), makeScheduler('b')],
      schedulerDetails: { a: makeSchedulerDetail('a'), b: makeSchedulerDetail('b') },
      jobDetails: { 'repeat:a:1000': makeJobDetail('repeat:a:1000') },
    });
  }

  it('opens the selected scheduler and pushes its view', async () => {
    const { deps, store } = await setup(stateWithDetail());
    await openSchedulersTab(store);

    await store.openSchedulerDetail();

    expect(deps.getSchedulerDetail).toHaveBeenCalledWith('q', 'a');
    const snap = store.getSnapshot();
    expect(snap.currentView).toEqual({ kind: 'scheduler', queueName: 'q', key: 'a' });
    expect(snap.schedulerDetail?.key).toBe('a');
    expect(snap.schedulerDetailLoading).toBe(false);
  });

  it('flags loading while the detail is fetched', async () => {
    const gate = deferred<SchedulerDetail | null>();
    const { deps, store } = await setup(stateWithDetail());
    await openSchedulersTab(store);
    vi.mocked(deps.getSchedulerDetail).mockReturnValueOnce(gate.promise);

    const opening = store.openSchedulerDetail();
    expect(store.getSnapshot().schedulerDetailLoading).toBe(true);
    gate.resolve(makeSchedulerDetail('a'));
    await opening;
    expect(store.getSnapshot().schedulerDetailLoading).toBe(false);
  });

  it('does nothing without a selected scheduler or off the Schedulers tab', async () => {
    const { deps, store } = await setup(emptyState());
    await store.openSchedulerDetail();
    store.pushJobsView();
    await flush();
    await store.openSchedulerDetail();
    expect(deps.getSchedulerDetail).not.toHaveBeenCalled();

    store.selectTab('schedulers');
    await flush();
    await store.openSchedulerDetail();
    expect(deps.getSchedulerDetail).not.toHaveBeenCalled();
    expect(store.getSnapshot().currentView.kind).toBe('jobs');
  });

  it('toasts when the scheduler is gone by the time it is opened', async () => {
    const state = stateWithDetail();
    state.schedulerDetails.a = null;
    const { store } = await setup(state);
    await openSchedulersTab(store);
    await store.openSchedulerDetail();
    expect(store.getSnapshot().currentView.kind).toBe('jobs');
    expect(store.getSnapshot().toasts.map((t) => t.message)).toEqual(['Scheduler a not found']);
  });

  it('toasts when loading the detail throws', async () => {
    const { deps, store } = await setup(stateWithDetail());
    await openSchedulersTab(store);
    vi.mocked(deps.getSchedulerDetail).mockRejectedValueOnce(new Error('blip'));
    await store.openSchedulerDetail();
    expect(store.getSnapshot().schedulerDetailLoading).toBe(false);
    expect(store.getSnapshot().toasts.map((t) => t.message)).toEqual([
      'Could not load scheduler a: blip',
    ]);
  });

  it('drops a detail that lands after the user navigated away', async () => {
    const gate = deferred<SchedulerDetail | null>();
    const { deps, store } = await setup(stateWithDetail());
    await openSchedulersTab(store);
    vi.mocked(deps.getSchedulerDetail).mockReturnValueOnce(gate.promise);

    const opening = store.openSchedulerDetail();
    store.popView();
    gate.resolve(makeSchedulerDetail('a'));
    await opening;

    expect(store.getSnapshot().currentView.kind).toBe('queues');
    expect(store.getSnapshot().schedulerDetail).toBeNull();
  });

  it('reloads the open detail on every refresh', async () => {
    const state = stateWithDetail();
    const { store } = await setup(state);
    await openSchedulersTab(store);
    await store.openSchedulerDetail();

    state.schedulerDetails.a = makeSchedulerDetail('a', { iterationCount: 7 });
    await store.refresh();
    expect(store.getSnapshot().schedulerDetail?.iterationCount).toBe(7);
  });

  it('keeps the last detail on screen when a reload fails', async () => {
    const { deps, store } = await setup(stateWithDetail());
    await openSchedulersTab(store);
    await store.openSchedulerDetail();
    vi.mocked(deps.getSchedulerDetail).mockRejectedValueOnce(new Error('blip'));
    await store.refresh();
    expect(store.getSnapshot().schedulerDetail?.key).toBe('a');
    expect(store.getSnapshot().currentView.kind).toBe('scheduler');
  });

  it('pops the view with a toast when the scheduler disappears', async () => {
    const state = stateWithDetail();
    const { store } = await setup(state);
    await openSchedulersTab(store);
    await store.openSchedulerDetail();

    state.schedulerDetails.a = null;
    await store.refresh();

    const snap = store.getSnapshot();
    expect(snap.currentView.kind).toBe('jobs');
    expect(snap.schedulerDetail).toBeNull();
    expect(snap.toasts.map((t) => t.message)).toEqual(['Scheduler a no longer exists']);
  });

  it('discards a reload that a newer navigation superseded', async () => {
    const state = stateWithDetail();
    const { deps, store } = await setup(state);
    await openSchedulersTab(store);
    await store.openSchedulerDetail();

    const gate = deferred<SchedulerDetail | null>();
    vi.mocked(deps.getSchedulerDetail).mockReturnValueOnce(gate.promise);
    const refreshing = store.refresh();
    await flush();
    store.popView();
    gate.resolve(null);
    await refreshing;

    expect(store.getSnapshot().toasts).toEqual([]);
    expect(store.getSnapshot().currentView.kind).toBe('jobs');
  });

  it('clears the detail when leaving with Esc or jumping home', async () => {
    const { store } = await setup(stateWithDetail());
    await openSchedulersTab(store);
    await store.openSchedulerDetail();
    store.popView();
    expect(store.getSnapshot().schedulerDetail).toBeNull();

    await store.openSchedulerDetail();
    store.popToQueues();
    expect(store.getSnapshot().schedulerDetail).toBeNull();
    expect(store.getSnapshot().currentView.kind).toBe('queues');
  });

  it('opens the next job on Enter and returns to the scheduler with Esc', async () => {
    const { deps, store } = await setup(stateWithDetail());
    await openSchedulersTab(store);
    await store.openSchedulerDetail();

    await store.openSchedulerNextJob();
    expect(deps.getJobDetail).toHaveBeenCalledWith('q', 'repeat:a:1000');
    expect(store.getSnapshot().currentView).toEqual({
      kind: 'detail',
      queueName: 'q',
      jobId: 'repeat:a:1000',
    });
    expect(store.getSnapshot().navigationStack.map((v) => v.kind)).toEqual([
      'queues',
      'jobs',
      'scheduler',
      'detail',
    ]);

    store.closeDetail();
    expect(store.getSnapshot().currentView).toEqual({
      kind: 'scheduler',
      queueName: 'q',
      key: 'a',
    });
    expect(store.getSnapshot().schedulerDetail?.key).toBe('a');
    expect(store.getSnapshot().detail).toBeNull();
  });

  it('does nothing on Enter when there is no next job', async () => {
    const state = stateWithDetail();
    state.schedulerDetails.a = makeSchedulerDetail('a', { nextJobId: null });
    const { deps, store } = await setup(state);
    await openSchedulersTab(store);
    await store.openSchedulerDetail();

    await store.openSchedulerNextJob();
    expect(deps.getJobDetail).not.toHaveBeenCalled();
    expect(store.getSnapshot().currentView.kind).toBe('scheduler');
  });

  it('does nothing on Enter outside the scheduler detail', async () => {
    const { deps, store } = await setup(stateWithDetail());
    await openSchedulersTab(store);
    await store.openSchedulerNextJob();
    expect(deps.getJobDetail).not.toHaveBeenCalled();
  });

  it('toasts when the next job has already run and vanished', async () => {
    const state = stateWithDetail();
    state.jobDetails = {};
    const { store } = await setup(state);
    await openSchedulersTab(store);
    await store.openSchedulerDetail();
    await store.openSchedulerNextJob();
    expect(store.getSnapshot().currentView.kind).toBe('scheduler');
    expect(store.getSnapshot().toasts.map((t) => t.message)).toEqual([
      'Job repeat:a:1000 not found',
    ]);
  });
});

describe('Schedulers: job-only keys are inert', () => {
  async function onSchedulersTab() {
    const state = emptyState({
      schedulers: [makeScheduler('a')],
      schedulerDetails: { a: makeSchedulerDetail('a') },
    });
    const ctx = await setup(state);
    await openSchedulersTab(ctx.store);
    return ctx;
  }

  it('ignores retry, promote, delete and duplicate on the Schedulers tab', async () => {
    const { deps, store } = await onSchedulersTab();
    await store.retrySelected();
    await store.promoteSelected();
    await store.deleteSelected();
    store.requestDelete();
    store.requestDuplicate();
    await store.openDetail();

    expect(deps.actions.retry).not.toHaveBeenCalled();
    expect(deps.actions.promote).not.toHaveBeenCalled();
    expect(deps.actions.delete).not.toHaveBeenCalled();
    expect(store.getSnapshot().confirmDeleteJobId).toBeNull();
    expect(store.getSnapshot().confirmDuplicateJobId).toBeNull();
    expect(store.getSnapshot().currentView.kind).toBe('jobs');
  });

  it('ignores them in the scheduler detail too', async () => {
    const { deps, store } = await onSchedulersTab();
    await store.openSchedulerDetail();
    await store.retrySelected();
    store.requestDelete();
    store.requestDuplicate();
    await store.copyDetailData();

    expect(deps.actions.retry).not.toHaveBeenCalled();
    expect(store.getSnapshot().confirmDeleteJobId).toBeNull();
    expect(store.getSnapshot().confirmDuplicateJobId).toBeNull();
    expect(store.getSnapshot().toasts).toEqual([]);
  });

  it('does not open the search input on the Schedulers tab', async () => {
    const { store } = await onSchedulersTab();
    store.openSearch();
    expect(store.getSnapshot().search.active).toBe(false);
  });
});

describe('Detail loading races', () => {
  function raceState(): FakeState {
    return emptyState({
      schedulers: [makeScheduler('a')],
      schedulerDetails: { a: makeSchedulerDetail('a') },
      jobDetails: { 'repeat:a:1000': makeJobDetail('repeat:a:1000') },
    });
  }

  async function atSchedulerDetail() {
    const ctx = await setup(raceState());
    await openSchedulersTab(ctx.store);
    await ctx.store.openSchedulerDetail();
    return ctx;
  }

  it('drops the next job when Esc is pressed while it loads', async () => {
    const { deps, store } = await atSchedulerDetail();
    const gate = deferred<JobDetail | null>();
    vi.mocked(deps.getJobDetail).mockReturnValueOnce(gate.promise);

    const opening = store.openSchedulerNextJob();
    expect(store.getSnapshot().detailLoading).toBe(true);
    store.popView();
    gate.resolve(makeJobDetail('repeat:a:1000'));
    await opening;

    const snap = store.getSnapshot();
    expect(snap.navigationStack.map((v) => v.kind)).toEqual(['queues', 'jobs']);
    expect(snap.detail).toBeNull();
    expect(snap.detailLoading).toBe(false);
  });

  it('drops the next job when H is pressed while it loads', async () => {
    const { deps, store } = await atSchedulerDetail();
    const gate = deferred<JobDetail | null>();
    vi.mocked(deps.getJobDetail).mockReturnValueOnce(gate.promise);

    const opening = store.openSchedulerNextJob();
    store.popToQueues();
    gate.resolve(makeJobDetail('repeat:a:1000'));
    await opening;

    expect(store.getSnapshot().navigationStack.map((v) => v.kind)).toEqual(['queues']);
    expect(store.getSnapshot().detail).toBeNull();
    expect(store.getSnapshot().detailLoading).toBe(false);
  });

  it('pushes exactly one detail frame on a double Enter', async () => {
    const { deps, store } = await atSchedulerDetail();
    const gate = deferred<JobDetail | null>();
    vi.mocked(deps.getJobDetail).mockReturnValueOnce(gate.promise);

    const first = store.openSchedulerNextJob();
    const second = store.openSchedulerNextJob();
    gate.resolve(makeJobDetail('repeat:a:1000'));
    await Promise.all([first, second]);

    expect(store.getSnapshot().navigationStack.map((v) => v.kind)).toEqual([
      'queues',
      'jobs',
      'scheduler',
      'detail',
    ]);
    expect(deps.getJobDetail).toHaveBeenCalledTimes(1);
  });

  it('pushes exactly one scheduler frame on a double Enter', async () => {
    const ctx = await setup(raceState());
    await openSchedulersTab(ctx.store);
    const gate = deferred<SchedulerDetail | null>();
    vi.mocked(ctx.deps.getSchedulerDetail).mockReturnValueOnce(gate.promise);

    const first = ctx.store.openSchedulerDetail();
    const second = ctx.store.openSchedulerDetail();
    gate.resolve(makeSchedulerDetail('a'));
    await Promise.all([first, second]);

    expect(ctx.store.getSnapshot().navigationStack.map((v) => v.kind)).toEqual([
      'queues',
      'jobs',
      'scheduler',
    ]);
  });

  it('drops a plain job detail when the user leaves while it loads', async () => {
    const state = raceState();
    const ctx = await setup(state);
    ctx.store.pushJobsView();
    await flush();
    vi.mocked(ctx.deps.fetchJobPage).mockResolvedValue({
      jobs: [{ id: 'j1', name: 'n', attemptsMade: 0, timestamp: 0, progress: null }],
      totalCount: 1,
      page: 0,
      pageCount: 1,
      counts: ZERO_COUNTS,
    });
    await ctx.store.refresh();
    const gate = deferred<JobDetail | null>();
    vi.mocked(ctx.deps.getJobDetail).mockReturnValueOnce(gate.promise);

    const opening = ctx.store.openDetail();
    ctx.store.popView();
    gate.resolve(makeJobDetail('j1'));
    await opening;

    expect(ctx.store.getSnapshot().navigationStack.map((v) => v.kind)).toEqual(['queues']);
    expect(ctx.store.getSnapshot().detail).toBeNull();
  });

  it.each([
    ['selectTab', (s: DashboardStore) => s.selectTab(1)],
    ['selectAdjacentTab', (s: DashboardStore) => s.selectAdjacentTab(-1)],
  ])('drops a scheduler detail when %s changes the tab while it loads', async (_n, act) => {
    const ctx = await setup(raceState());
    await openSchedulersTab(ctx.store);
    const gate = deferred<SchedulerDetail | null>();
    vi.mocked(ctx.deps.getSchedulerDetail).mockReturnValueOnce(gate.promise);

    const opening = ctx.store.openSchedulerDetail();
    act(ctx.store);
    gate.resolve(makeSchedulerDetail('a'));
    await opening;
    await flush();

    const snap = ctx.store.getSnapshot();
    expect(snap.navigationStack.map((v) => v.kind)).toEqual(['queues', 'jobs']);
    expect(snap.schedulerDetail).toBeNull();
    expect(snap.schedulerDetailLoading).toBe(false);
  });

  it('drops a scheduler detail when the queue changes while it loads', async () => {
    const ctx = await setup(raceState());
    ctx.deps.discoverQueues = vi.fn(async () => [
      { name: 'q', isPaused: false },
      { name: 'q2', isPaused: false },
    ]);
    await ctx.store.refresh();
    await openSchedulersTab(ctx.store);
    const gate = deferred<SchedulerDetail | null>();
    vi.mocked(ctx.deps.getSchedulerDetail).mockReturnValueOnce(gate.promise);

    const opening = ctx.store.openSchedulerDetail();
    ctx.store.selectQueue('q2');
    gate.resolve(makeSchedulerDetail('a'));
    await opening;

    expect(ctx.store.getSnapshot().currentView.kind).toBe('jobs');
    expect(ctx.store.getSnapshot().schedulerDetail).toBeNull();
  });
});

describe('Schedulers tab: page size', () => {
  it('pages schedulers by the store page size and keeps the selected one in view', async () => {
    const schedulers = Array.from({ length: 12 }, (_, i) => makeScheduler(`s${i}`));
    const { deps, store } = await setup(emptyState({ schedulers }));
    await openSchedulersTab(store);
    for (let i = 0; i < 6; i++) store.selectNextScheduler(); // s6
    expect(store.getSnapshot().selectedSchedulerKey).toBe('s6');

    store.setPageSize(4);
    await flush();

    expect(deps.fetchSchedulerPage).toHaveBeenLastCalledWith('q', 1, 4);
    expect(store.getSnapshot().schedulerPage?.schedulers.map((s) => s.key)).toEqual([
      's4',
      's5',
      's6',
      's7',
    ]);
    expect(store.getSnapshot().selectedSchedulerKey).toBe('s6');
  });
});

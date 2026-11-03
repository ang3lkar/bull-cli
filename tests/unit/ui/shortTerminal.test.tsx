import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardStore, type StoreDeps } from '../../../src/core/store.js';
import type { JobStatus, JobSummary, SchedulerSummary } from '../../../src/core/types.js';

/**
 * Issue #5: the job list must page to the terminal height instead of handing
 * Yoga more rows than fit. ink-testing-library's stdout has no `rows`, so the
 * terminal size is mocked; `dims` is mutable so a test can "resize".
 */
const dims: { columns: number | undefined; rows: number | undefined } = {
  columns: 100,
  rows: 18,
};
vi.mock('../../../src/ui/hooks/useTerminalDimensions.js', () => ({
  useTerminalDimensions: () => ({ ...dims }),
}));
const { App } = await import('../../../src/ui/App.js');

const NOW = 1_700_000_000_000;
const TOTAL = 10;
const job = (id: string): JobSummary => ({
  id,
  name: 'send-email',
  attemptsMade: 1,
  timestamp: NOW,
  progress: null,
});
const jobs = Array.from({ length: TOTAL }, (_, i) => job(`delayed-${i + 1}`));
const schedulers: SchedulerSummary[] = Array.from({ length: TOTAL }, (_, i) => ({
  key: `sched-${i + 1}`,
  name: 'report',
  pattern: '0 * * * *',
  every: null,
  tz: null,
  next: NOW,
  iterationCount: 0,
  limit: null,
}));
const counts: Record<JobStatus, number> = {
  active: 0,
  waiting: 0,
  completed: 0,
  failed: 0,
  delayed: TOTAL,
};

function slice<T>(items: T[], page: number, size: number) {
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(page, 0), pageCount - 1);
  return {
    items: items.slice(current * size, current * size + size),
    page: current,
    pageCount,
  };
}

const stores: DashboardStore[] = [];

async function mountJobList(rows: number) {
  dims.rows = rows;
  const deps = {
    discoverQueues: async () => [{ name: 'emailQ', isPaused: false }],
    fetchQueueCounts: async () => counts,
    fetchJobPage: vi.fn(async (_q: string, _s: JobStatus, page: number, size: number) => {
      const { items, ...rest } = slice(jobs, page, size);
      return { jobs: items, totalCount: TOTAL, counts, ...rest };
    }),
    fetchSchedulerPage: vi.fn(async (_q: string, page: number, size: number) => {
      const { items, ...rest } = slice(schedulers, page, size);
      return { schedulers: items, totalCount: TOTAL, ...rest };
    }),
    getJobDetail: async () => null,
    getSchedulerDetail: async () => null,
    actions: {} as StoreDeps['actions'],
    syncRegistry: async () => {},
  } satisfies StoreDeps;
  const store = new DashboardStore(deps, { redisUrl: 'redis://localhost:6379' });
  stores.push(store);
  await store.refresh();
  store.pushJobsView();
  await flush();
  const setPageSize = vi.spyOn(store, 'setPageSize');
  const instance = render(<App store={store} onQuit={() => {}} />);
  await flush();
  return { store, deps, setPageSize, ...instance };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

function lines(frame: string | undefined): string[] {
  return (frame ?? '').split('\n');
}

/** Ids of the rows on screen, in order. */
function shownIds(frame: string | undefined, prefix = 'delayed-'): string[] {
  return lines(frame).flatMap((line) => line.match(new RegExp(`${prefix}\\d+`)) ?? []);
}

beforeEach(() => vi.useFakeTimers({ now: NOW }));
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
  dims.rows = 18;
});

describe('job list in a short terminal (issue #5)', () => {
  it.each([
    18, 22, 26,
  ])('at %i rows shows a contiguous first page, the selection and the footer', async (rows) => {
    const { store, lastFrame } = await mountJobList(rows);
    const frame = lastFrame();
    const size = store.getSnapshot().pageSize;

    expect(lines(frame).length).toBeLessThanOrEqual(rows);
    expect(size).toBeLessThan(TOTAL);
    expect(shownIds(frame)).toEqual(jobs.slice(0, size).map((j) => j.id));
    expect(frame).toMatch(/❯\s+delayed-1\s/);
    expect(frame).toContain(`Page 1 of ${Math.ceil(TOTAL / size)}`);
    expect(frame).toContain('redis://localhost:6379');
    expect(frame).toContain('prefix bull');
  });

  it('keeps every row when the terminal is tall enough', async () => {
    const { lastFrame } = await mountJobList(45);
    expect(shownIds(lastFrame())).toHaveLength(TOTAL);
    expect(lastFrame()).toContain('Page 1 of 1');
  });

  it('settles on one page size rather than looping', async () => {
    const { setPageSize, store } = await mountJobList(18);
    const sizes = new Set(setPageSize.mock.calls.map(([size]) => size));
    expect(sizes).toEqual(new Set([store.getSnapshot().pageSize]));
  });

  it('a toast does not change the page size', async () => {
    const { store, deps } = await mountJobList(24);
    const size = store.getSnapshot().pageSize;
    const fetches = deps.fetchJobPage.mock.calls.length;

    store.pushToast('Something happened');
    await flush();

    expect(store.getSnapshot().pageSize).toBe(size);
    expect(deps.fetchJobPage.mock.calls.length).toBe(fetches);
  });

  it('keeps the selected job on screen when the terminal shrinks', async () => {
    const { store, rerender, lastFrame } = await mountJobList(45);
    for (let i = 0; i < 7; i++) store.selectNextJob();
    expect(store.getSnapshot().selectedJobId).toBe('delayed-8');

    dims.rows = 18;
    rerender(<App store={store} onQuit={() => {}} />);
    await flush();

    const frame = lastFrame();
    expect(lines(frame).length).toBeLessThanOrEqual(18);
    expect(frame).toMatch(/❯\s+delayed-8\s/);
    expect(shownIds(frame)).toContain('delayed-8');
  });

  it('opening search re-pages around the selected job instead of hiding it', async () => {
    const { store, stdin, lastFrame } = await mountJobList(26);
    const before = store.getSnapshot().pageSize;
    for (let i = 1; i < before; i++) store.selectNextJob(); // last row of the page
    const selected = store.getSnapshot().selectedJobId;
    await flush();

    stdin.write('/');
    await flush();

    const size = store.getSnapshot().pageSize;
    const frame = lastFrame();
    expect(size).toBeLessThan(before); // the search bar took rows from the table
    expect(lines(frame).length).toBeLessThanOrEqual(26);
    expect(frame).toMatch(new RegExp(`❯\\s+${selected}\\s`));
    expect(frame).toContain(`Page ${store.getSnapshot().page + 1} of ${Math.ceil(TOTAL / size)}`);
  });

  it('pages the Schedulers tab to the terminal height too', async () => {
    const { store, lastFrame } = await mountJobList(18);
    store.selectTab('schedulers');
    await flush();
    const frame = lastFrame();
    const size = store.getSnapshot().pageSize;

    expect(lines(frame).length).toBeLessThanOrEqual(18);
    expect(shownIds(frame, 'sched-')).toEqual(schedulers.slice(0, size).map((s) => s.key));
    expect(frame).toContain(`Page 1 of ${Math.ceil(TOTAL / size)}`);
    expect(frame).toContain('prefix bull');
  });
});

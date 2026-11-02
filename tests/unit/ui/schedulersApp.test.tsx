import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardStore, type StoreDeps } from '../../../src/core/store.js';
import type {
  ActionResult,
  JobDetail,
  JobStatus,
  SchedulerDetail,
  SchedulerSummary,
} from '../../../src/core/types.js';
import { App } from '../../../src/ui/App.js';

const NOW = 1_700_000_000_000;
const ZERO: Record<JobStatus, number> = {
  active: 0,
  waiting: 0,
  completed: 0,
  failed: 0,
  delayed: 1,
};

function scheduler(key: string, overrides: Partial<SchedulerSummary> = {}): SchedulerSummary {
  return {
    key,
    name: `${key}-job`,
    pattern: null,
    every: 300_000,
    tz: null,
    next: NOW + 120_000,
    iterationCount: 1,
    limit: null,
    ...overrides,
  };
}

function schedulerDetail(key: string): SchedulerDetail {
  return {
    ...scheduler(key),
    startDate: null,
    endDate: null,
    offset: null,
    template: { data: { marker: `template-${key}` }, opts: {} },
    nextJobId: `repeat:${key}:1`,
  };
}

const jobDetail: JobDetail = {
  id: 'repeat:a:1',
  name: 'a-job',
  attemptsMade: 0,
  timestamp: NOW,
  progress: null,
  data: { jobMarker: true },
  returnvalue: undefined,
  stacktrace: [],
  opts: {},
  timestamps: { created: NOW, processed: null, finished: null },
  rawProgress: null,
  state: 'delayed',
  failedReason: null,
};

const schedulers = [scheduler('a'), scheduler('b')];

function setup() {
  const deps: StoreDeps = {
    discoverQueues: vi.fn(async () => [{ name: 'emailQ', isPaused: false }]),
    fetchQueueCounts: vi.fn(async () => ZERO),
    fetchJobPage: vi.fn(async () => ({
      jobs: [{ id: 'j1', name: 'delayed-job', attemptsMade: 0, timestamp: NOW, progress: null }],
      totalCount: 1,
      page: 0,
      pageCount: 1,
      counts: ZERO,
    })),
    getJobDetail: vi.fn(async () => jobDetail),
    fetchSchedulerPage: vi.fn(async () => ({
      schedulers,
      totalCount: schedulers.length,
      page: 0,
      pageCount: 1,
    })),
    fetchSchedulerCount: vi.fn(async () => schedulers.length),
    getSchedulerDetail: vi.fn(async (_q, key) => schedulerDetail(key)),
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
  return { deps, store: new DashboardStore(deps, { redisUrl: 'redis://x' }) };
}

const stores: DashboardStore[] = [];

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function mount() {
  const ctx = setup();
  stores.push(ctx.store);
  await ctx.store.refresh();
  const app = render(<App store={ctx.store} onQuit={vi.fn()} />);
  await flush();
  return { ...ctx, ...app };
}

async function press(stdin: { write: (s: string) => void }, keys: string): Promise<void> {
  stdin.write(keys);
  await flush();
}

beforeEach(() => vi.useFakeTimers({ now: NOW }));
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});

describe('App: Schedulers tab', () => {
  it('shows the Schedulers tab with its count in the job list', async () => {
    const { stdin, lastFrame } = await mount();
    await press(stdin, '\r');
    expect(lastFrame()).toContain('Schedulers');
    expect(lastFrame()).toContain('(2)');
  });

  it('jumps to the Schedulers tab with 6 and lists the schedulers', async () => {
    const { stdin, lastFrame, store } = await mount();
    await press(stdin, '\r');
    await press(stdin, '6');

    expect(store.getSnapshot().tab).toBe('schedulers');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('[Schedulers]');
    expect(frame).toContain('Queues > emailQ > schedulers');
    expect(frame).toContain('every 5m');
    expect(frame).toContain('in 2m');
    expect(frame).toContain('a-job');
    expect(frame).toContain('1-6');
    expect(frame).not.toContain('Delete');
  });

  it('is reached with the right arrow from Completed and left goes back', async () => {
    const { stdin, store } = await mount();
    await press(stdin, '\r');
    await press(stdin, '5');
    expect(store.getSnapshot().tab).toBe('completed');
    await press(stdin, '\u001B[C');
    expect(store.getSnapshot().tab).toBe('schedulers');
    await press(stdin, '\u001B[C');
    expect(store.getSnapshot().tab).toBe('schedulers');
    await press(stdin, '\u001B[D');
    expect(store.getSnapshot().tab).toBe('completed');
  });

  it('moves the selection with the arrow keys and pages with b/n', async () => {
    const { stdin, store, deps } = await mount();
    await press(stdin, '\r');
    await press(stdin, '6');
    expect(store.getSnapshot().selectedSchedulerKey).toBe('a');
    await press(stdin, '\u001B[B');
    expect(store.getSnapshot().selectedSchedulerKey).toBe('b');
    await press(stdin, '\u001B[A');
    expect(store.getSnapshot().selectedSchedulerKey).toBe('a');

    const calls = vi.mocked(deps.fetchSchedulerPage).mock.calls.length;
    await press(stdin, 'n');
    await press(stdin, 'b');
    expect(vi.mocked(deps.fetchSchedulerPage).mock.calls.length).toBe(calls);
  });

  it('opens a scheduler with Enter, then its next job, and unwinds with Esc', async () => {
    const { stdin, lastFrame, store } = await mount();
    await press(stdin, '\r');
    await press(stdin, '6');
    await press(stdin, '\r');

    expect(store.getSnapshot().currentView).toEqual({
      kind: 'scheduler',
      queueName: 'emailQ',
      key: 'a',
    });
    expect(lastFrame()).toContain('template-a');
    expect(lastFrame()).toContain('Queues > emailQ > schedulers > a');
    expect(lastFrame()).toContain('Next job');

    await press(stdin, '\r');
    expect(store.getSnapshot().currentView.kind).toBe('detail');
    expect(lastFrame()).toContain('jobMarker');
    expect(lastFrame()).toContain('Queues > emailQ > schedulers > a > job #repeat:a:1');

    await press(stdin, '\u001B');
    expect(store.getSnapshot().currentView.kind).toBe('scheduler');
    await press(stdin, 'h');
    expect(store.getSnapshot().currentView.kind).toBe('jobs');
    expect(store.getSnapshot().tab).toBe('schedulers');
  });

  it('leaves job-only keys inert on the list and in the scheduler detail', async () => {
    const { stdin, store, deps } = await mount();
    await press(stdin, '\r');
    await press(stdin, '6');

    for (const keys of ['R', 'D', 'p', 'c', '/']) {
      await press(stdin, keys);
    }
    expect(store.getSnapshot().search.active).toBe(false);
    expect(store.getSnapshot().confirmDeleteJobId).toBeNull();
    expect(store.getSnapshot().confirmDuplicateJobId).toBeNull();

    await press(stdin, '\r');
    expect(store.getSnapshot().currentView.kind).toBe('scheduler');
    for (const keys of ['R', 'D', 'p', 'c', '/', '\u001B[B', 'n']) {
      await press(stdin, keys);
    }
    expect(store.getSnapshot().search.active).toBe(false);
    expect(store.getSnapshot().confirmDeleteJobId).toBeNull();
    expect(store.getSnapshot().currentView.kind).toBe('scheduler');
    expect(deps.actions.retry).not.toHaveBeenCalled();
    expect(deps.actions.promote).not.toHaveBeenCalled();
    expect(deps.actions.delete).not.toHaveBeenCalled();
  });

  it('shows the empty state when the queue has no schedulers', async () => {
    const { stdin, lastFrame, deps } = await mount();
    vi.mocked(deps.fetchSchedulerPage).mockResolvedValue({
      schedulers: [],
      totalCount: 0,
      page: 0,
      pageCount: 1,
    });
    await press(stdin, '\r');
    await press(stdin, '6');
    expect(lastFrame()).toContain('No job schedulers');
  });
});

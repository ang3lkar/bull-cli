import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardStore, type StoreDeps } from '../../../src/core/store.js';
import type {
  ActionResult,
  JobDetail,
  JobPage,
  JobStatus,
  JobSummary,
  QueueInfo,
} from '../../../src/core/types.js';
import { App } from '../../../src/ui/App.js';

const NOW = 1_700_000_000_000;

// --- fixtures & fakes (mirrors tests/unit/store.test.ts's shape) ----------

function makeQueue(name: string, isPaused = false): QueueInfo {
  return { name, isPaused };
}

function makeJob(id: string, name: string, overrides: Partial<JobSummary> = {}): JobSummary {
  return { id, name, attemptsMade: 0, timestamp: NOW, progress: null, ...overrides };
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
      togglePause: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
      drain: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
    },
    syncRegistry: vi.fn(async () => {}),
  };
}

function buildState(): FakeState {
  const waitingJobs = Array.from({ length: 15 }, (_, i) => makeJob(`w${i}`, `job-w${i}`));
  return {
    queues: [makeQueue('emailQ'), makeQueue('smsQ', true)],
    jobs: {
      [jobKey('emailQ', 'active')]: [
        makeJob('a1', 'send-email', { progress: 10 }),
        makeJob('a2', 'send-email', { progress: 20 }),
      ],
      [jobKey('emailQ', 'waiting')]: waitingJobs,
      [jobKey('emailQ', 'completed')]: [makeJob('c1', 'send-email')],
      [jobKey('emailQ', 'failed')]: [makeJob('f1', 'send-email', { attemptsMade: 3 })],
      [jobKey('emailQ', 'delayed')]: [makeJob('d1', 'send-email')],
      [jobKey('smsQ', 'active')]: [],
      [jobKey('smsQ', 'waiting')]: [],
      [jobKey('smsQ', 'completed')]: [],
      [jobKey('smsQ', 'failed')]: [],
      [jobKey('smsQ', 'delayed')]: [],
    },
    details: {
      [detailKey('emailQ', 'f1')]: {
        id: 'f1',
        name: 'send-email',
        attemptsMade: 3,
        timestamp: NOW,
        progress: null,
        data: { to: 'a@b.com' },
        returnvalue: null,
        stacktrace: ['Error: boom', '  at foo.js:1:1'],
        opts: {},
        timestamps: { created: NOW, processed: NOW, finished: NOW },
        rawProgress: null,
      },
    },
  };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

const activeStores: DashboardStore[] = [];

function track(store: DashboardStore): DashboardStore {
  activeStores.push(store);
  return store;
}

async function setup(state: FakeState = buildState()) {
  const deps = createFakeDeps(state);
  const store = track(new DashboardStore(deps, { redisUrl: 'redis://localhost:6379' }));
  await store.refresh();
  const onQuit = vi.fn();
  const instance = render(<App store={store} onQuit={onQuit} />);
  await flush();
  return { deps, store, onQuit, state, ...instance };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  for (const store of activeStores.splice(0)) {
    store.dispose();
  }
  vi.useRealTimers();
});

// --- tests -----------------------------------------------------------------

describe('App: focus toggle (Tab)', () => {
  it('toggles focus between sidebar and job list, moving the ❯ marker', async () => {
    const { store, stdin, lastFrame } = await setup();
    expect(store.getSnapshot().focus).toBe('sidebar');

    let frame = lastFrame() ?? '';
    let lines = frame.split('\n');
    expect(lines.find((l) => l.includes('emailQ'))).toContain('❯');

    stdin.write('\t');
    await flush();
    expect(store.getSnapshot().focus).toBe('jobs');

    frame = lastFrame() ?? '';
    lines = frame.split('\n');
    expect(lines.find((l) => l.includes('emailQ'))).not.toContain('❯');
    expect(lines.find((l) => l.includes('a1'))).toContain('❯');

    stdin.write('\t');
    await flush();
    expect(store.getSnapshot().focus).toBe('sidebar');
  });
});

describe('App: sidebar navigation', () => {
  it('↑/↓ change the selected queue while sidebar is focused', async () => {
    const { store, stdin } = await setup();
    expect(store.getSnapshot().selectedQueueName).toBe('emailQ');

    stdin.write('[B'); // down
    await flush();
    expect(store.getSnapshot().selectedQueueName).toBe('smsQ');

    stdin.write('[A'); // up
    await flush();
    expect(store.getSnapshot().selectedQueueName).toBe('emailQ');
  });
});

describe('App: job navigation', () => {
  it('↑/↓ change the selected job row while jobs are focused', async () => {
    const { store, stdin } = await setup();
    stdin.write('\t'); // focus jobs
    await flush();
    expect(store.getSnapshot().selectedJobId).toBe('a1');

    stdin.write('[B'); // down
    await flush();
    expect(store.getSnapshot().selectedJobId).toBe('a2');

    stdin.write('[A'); // up
    await flush();
    expect(store.getSnapshot().selectedJobId).toBe('a1');
  });
});

describe('App: tab switching', () => {
  it('←/→ switch status tabs, clamped at both ends', async () => {
    const { store, stdin, lastFrame } = await setup();
    stdin.write('\t'); // focus jobs
    await flush();
    expect(store.getSnapshot().tab).toBe('active');
    expect(lastFrame()).toContain('[Active]');

    stdin.write('[C'); // right -> waiting
    await flush();
    expect(store.getSnapshot().tab).toBe('waiting');
    expect(lastFrame()).toContain('[Waiting]');

    stdin.write('[D'); // left -> active
    await flush();
    expect(store.getSnapshot().tab).toBe('active');

    stdin.write('[D'); // left again: clamp, stays active
    await flush();
    expect(store.getSnapshot().tab).toBe('active');
  });

  it('1-5 select tabs directly', async () => {
    const { store, stdin, lastFrame } = await setup();
    stdin.write('\t');
    await flush();

    stdin.write('4'); // failed
    await flush();
    expect(store.getSnapshot().tab).toBe('failed');
    expect(lastFrame()).toContain('[Failed]');

    stdin.write('5'); // delayed
    await flush();
    expect(store.getSnapshot().tab).toBe('delayed');
  });
});

describe('App: pagination', () => {
  it('PgUp/PgDn paginate the job list', async () => {
    const { store, stdin, lastFrame } = await setup();
    stdin.write('\t'); // focus jobs
    await flush();
    stdin.write('2'); // waiting tab: 15 jobs -> 2 pages
    await flush();

    expect(lastFrame()).toContain('Page 1 of 2');

    stdin.write('[6~'); // PgDn
    await flush();
    expect(store.getSnapshot().page).toBe(1);
    expect(lastFrame()).toContain('Page 2 of 2');

    stdin.write('[5~'); // PgUp
    await flush();
    expect(store.getSnapshot().page).toBe(0);
    expect(lastFrame()).toContain('Page 1 of 2');
  });
});

describe('App: job detail modal', () => {
  it('Enter opens the modal, Escape closes it', async () => {
    const { store, stdin, lastFrame } = await setup();
    stdin.write('\t'); // focus jobs
    await flush();
    stdin.write('4'); // failed tab -> job f1
    await flush();
    expect(store.getSnapshot().selectedJobId).toBe('f1');

    stdin.write('\r'); // Enter
    await flush();
    expect(store.getSnapshot().detail?.id).toBe('f1');
    expect(lastFrame()).toContain('Stacktrace');

    stdin.write(''); // Escape
    await flush();
    expect(store.getSnapshot().detail).toBeNull();
    expect(lastFrame()).not.toContain('Stacktrace');
  });
});

describe('App: search', () => {
  it('/ opens search, typing filters live, Escape clears+restores, Enter keeps filter with input closed', async () => {
    const { store, stdin, lastFrame } = await setup();
    stdin.write('\t'); // focus jobs
    await flush();
    stdin.write('2'); // waiting tab (job-w0..job-w14)
    await flush();

    stdin.write('/');
    await flush();
    expect(store.getSnapshot().search.active).toBe(true);
    expect(lastFrame()).toContain('/ ');

    // Filtering only ever applies to the currently loaded page (10 jobs:
    // w0..w9) — search filters the *visible* list, not the whole tab.
    stdin.write('w1');
    await flush();
    expect(store.getSnapshot().visibleJobs.map((j) => j.id)).toEqual(['w1']);
    expect(lastFrame()).not.toContain('job-w0');

    // Enter: closes the input but keeps the filter -- and that must be
    // visible on screen (the "(filtered)" indicator), not just in state,
    // otherwise a filtered list with a closed input looks unexplained.
    stdin.write('\r');
    await flush();
    expect(store.getSnapshot().search).toEqual({ active: false, query: 'w1' });
    expect(store.getSnapshot().visibleJobs.map((j) => j.id)).toEqual(['w1']);
    let frame = lastFrame() ?? '';
    expect(frame).toContain('(filtered)');
    expect(frame).toContain('/ w1');
    expect(frame).not.toContain('job-w0');

    // Global Escape (search input no longer active) clears the lingering filter.
    stdin.write('');
    await flush();
    expect(store.getSnapshot().search).toEqual({ active: false, query: '' });
    expect(store.getSnapshot().visibleJobs).toHaveLength(10); // full first page restored
    frame = lastFrame() ?? '';
    expect(frame).not.toContain('(filtered)');
    expect(frame).toContain('job-w0');
  });

  it('Escape while typing clears the query immediately and restores the full list', async () => {
    const { store, stdin } = await setup();
    stdin.write('\t');
    await flush();
    stdin.write('2');
    await flush();

    stdin.write('/');
    await flush();
    stdin.write('w1');
    await flush();
    expect(store.getSnapshot().visibleJobs.length).toBeLessThan(10);

    stdin.write(''); // Escape while search input is active
    await flush();
    expect(store.getSnapshot().search).toEqual({ active: false, query: '' });
    expect(store.getSnapshot().visibleJobs).toHaveLength(10);
  });

  it('Backspace edits the query while typing', async () => {
    const { store, stdin } = await setup();
    stdin.write('/');
    await flush();
    stdin.write('a2x');
    await flush();
    expect(store.getSnapshot().search.query).toBe('a2x');

    stdin.write(''); // backspace
    await flush();
    expect(store.getSnapshot().search.query).toBe('a2');
    expect(store.getSnapshot().visibleJobs.map((j) => j.id)).toEqual(['a2']);
  });
});

describe('App: sidebar actions', () => {
  it('p toggles pause on the selected queue', async () => {
    const { store, stdin, deps } = await setup();
    expect(store.getSnapshot().selectedQueueName).toBe('emailQ');

    stdin.write('p');
    await flush();
    expect(deps.actions.togglePause).toHaveBeenCalledWith('emailQ');
  });

  it('Shift+D shows a confirm prompt; y drains, n cancels, Escape cancels', async () => {
    const { store, stdin, deps, lastFrame } = await setup();

    stdin.write('D');
    await flush();
    expect(store.getSnapshot().confirmDrain).toBe(true);
    expect(lastFrame()).toContain('Drain');

    stdin.write('n');
    await flush();
    expect(store.getSnapshot().confirmDrain).toBe(false);
    expect(deps.actions.drain).not.toHaveBeenCalled();

    stdin.write('D');
    await flush();
    stdin.write(''); // Escape cancels too
    await flush();
    expect(store.getSnapshot().confirmDrain).toBe(false);
    expect(deps.actions.drain).not.toHaveBeenCalled();

    stdin.write('D');
    await flush();
    stdin.write('y');
    await flush();
    expect(deps.actions.drain).toHaveBeenCalledWith('emailQ');
    expect(store.getSnapshot().confirmDrain).toBe(false);
  });

  it('Shift+D also requests a drain from the job list (focus jobs)', async () => {
    const { store, stdin, deps } = await setup();
    stdin.write('\t'); // focus jobs
    await flush();

    stdin.write('D');
    await flush();
    expect(store.getSnapshot().confirmDrain).toBe(true);

    stdin.write('y');
    await flush();
    expect(deps.actions.drain).toHaveBeenCalledWith('emailQ');
  });
});

describe('App: job actions', () => {
  it('r retries on the failed tab', async () => {
    const { store, stdin, deps } = await setup();
    stdin.write('\t'); // focus jobs
    await flush();
    stdin.write('4'); // failed
    await flush();
    expect(store.getSnapshot().selectedJobId).toBe('f1');

    stdin.write('r');
    await flush();
    expect(deps.actions.retry).toHaveBeenCalledWith('emailQ', 'f1');
  });

  it('d deletes the selected job', async () => {
    const { store, stdin, deps } = await setup();
    stdin.write('\t');
    await flush();
    expect(store.getSnapshot().selectedJobId).toBe('a1');

    stdin.write('d');
    await flush();
    expect(deps.actions.delete).toHaveBeenCalledWith('emailQ', 'a1');
  });

  it('p promotes the selected job on the delayed tab', async () => {
    const { store, stdin, deps } = await setup();
    stdin.write('\t');
    await flush();
    stdin.write('5'); // delayed
    await flush();
    expect(store.getSnapshot().selectedJobId).toBe('d1');

    stdin.write('p');
    await flush();
    expect(deps.actions.promote).toHaveBeenCalledWith('emailQ', 'd1');
  });
});

describe('App: refresh and quit', () => {
  it('R calls refresh (dep call count bumps)', async () => {
    const { deps, stdin } = await setup();
    const before = (deps.discoverQueues as ReturnType<typeof vi.fn>).mock.calls.length;

    stdin.write('R');
    await flush();
    expect(deps.discoverQueues).toHaveBeenCalledTimes(before + 1);
  });

  it('q calls onQuit', async () => {
    const { stdin, onQuit } = await setup();
    stdin.write('q');
    await flush();
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  it('q also quits while the detail modal is open', async () => {
    const { store, stdin, onQuit } = await setup();
    stdin.write('\t'); // focus jobs
    await flush();
    stdin.write('4'); // failed tab -> job f1, which has detail fixture data
    await flush();
    stdin.write('\r'); // open detail for f1
    await flush();
    expect(store.getSnapshot().detail?.id).toBe('f1');

    stdin.write('q');
    await flush();
    expect(onQuit).toHaveBeenCalledTimes(1);
  });
});

describe('App: connection / empty states', () => {
  it('renders ErrorScreen when the connection is in an error state', async () => {
    const state = buildState();
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://localhost:6379' }));
    store.onConnectionStatus({
      state: 'error',
      url: 'redis://localhost:6379',
      message: 'ECONNREFUSED',
    });
    const onQuit = vi.fn();
    const { lastFrame } = render(<App store={store} onQuit={onQuit} />);
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Cannot connect to Redis');
    expect(frame).toContain('ECONNREFUSED');
  });

  it('renders EmptyState when discovery finds no queues', async () => {
    const state: FakeState = { queues: [], jobs: {}, details: {} };
    const deps = createFakeDeps(state);
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://localhost:6379' }));
    await store.refresh();
    const onQuit = vi.fn();
    const { lastFrame } = render(<App store={store} onQuit={onQuit} />);
    await flush();

    expect(lastFrame()).toContain('No BullMQ queues found on redis://localhost:6379');
  });
});

describe('App: toasts', () => {
  it('a failed action shows a toast that disappears after the auto-dismiss timer', async () => {
    const state = buildState();
    const deps = createFakeDeps(state);
    (deps.actions.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      message: 'Could not delete job a1',
    });
    const store = track(new DashboardStore(deps, { redisUrl: 'redis://localhost:6379' }));
    await store.refresh();
    const onQuit = vi.fn();
    const { stdin, lastFrame } = render(<App store={store} onQuit={onQuit} />);
    await flush();

    stdin.write('\t'); // focus jobs
    await flush();
    stdin.write('d');
    await flush();

    expect(lastFrame()).toContain('Could not delete job a1');

    await vi.advanceTimersByTimeAsync(4000); // default toastDurationMs
    expect(lastFrame()).not.toContain('Could not delete job a1');
  });
});

describe('App: footer ticking', () => {
  it('advancing 2s updates the "Last updated" counter', async () => {
    const { lastFrame } = await setup();
    expect(lastFrame()).toContain('Last updated: 0s ago');

    await vi.advanceTimersByTimeAsync(2000);
    expect(lastFrame()).toContain('Last updated: 2s ago');
  });
});

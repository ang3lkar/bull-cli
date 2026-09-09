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
const statuses: JobStatus[] = ['active', 'waiting', 'completed', 'failed', 'delayed'];

const counts = (jobs: Record<string, JobSummary[]>, queueName: string) =>
  Object.fromEntries(
    statuses.map((status) => [status, jobs[`${queueName}:${status}`]?.length ?? 0]),
  ) as Record<JobStatus, number>;

function job(id: string, name = 'send-email'): JobSummary {
  return { id, name, attemptsMade: 1, timestamp: NOW, progress: null };
}

function page(
  jobs: JobSummary[],
  requestedPage: number,
  jobCounts: Record<JobStatus, number>,
): JobPage {
  const pageCount = Math.max(1, Math.ceil(jobs.length / 10));
  const currentPage = Math.min(requestedPage, pageCount - 1);
  return {
    jobs: jobs.slice(currentPage * 10, currentPage * 10 + 10),
    totalCount: jobs.length,
    page: currentPage,
    pageCount,
    counts: jobCounts,
  };
}

function detail(id: string): JobDetail {
  return {
    ...job(id),
    data: { recipient: 'test@example.com' },
    returnvalue: null,
    stacktrace: ['Error: boom'],
    opts: {},
    timestamps: { created: NOW, processed: NOW, finished: NOW },
    rawProgress: null,
  };
}

function setup() {
  const queues: QueueInfo[] = [
    { name: 'emailQ', isPaused: false },
    { name: 'smsQ', isPaused: true },
  ];
  const jobs: Record<string, JobSummary[]> = {
    'emailQ:active': [job('active-1')],
    'emailQ:waiting': [job('waiting-1')],
    'emailQ:failed': [job('failed-1')],
    'emailQ:completed': [job('completed-1')],
    'emailQ:delayed': [job('delayed-1')],
  };
  const deps: StoreDeps = {
    discoverQueues: vi.fn(async () => queues),
    fetchQueueCounts: vi.fn(async (queueName) => counts(jobs, queueName)),
    fetchJobPage: vi.fn(async (queueName, status, requestedPage) =>
      page(jobs[`${queueName}:${status}`] ?? [], requestedPage, counts(jobs, queueName)),
    ),
    getJobDetail: vi.fn(async (_queueName, jobId) => detail(jobId)),
    copyToClipboard: vi.fn(async () => {}),
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
  const store = new DashboardStore(deps, { redisUrl: 'redis://localhost:6379' });
  const onQuit = vi.fn();
  return { deps, store, onQuit };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

const stores: DashboardStore[] = [];

async function mount() {
  const setupResult = setup();
  stores.push(setupResult.store);
  await setupResult.store.refresh();
  const instance = render(<App store={setupResult.store} onQuit={setupResult.onQuit} />);
  await flush();
  return { ...setupResult, ...instance };
}

beforeEach(() => vi.useFakeTimers({ now: NOW }));
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});

describe('App: first-load states', () => {
  it('shows the loading state until the first refresh resolves', async () => {
    const { deps, store, onQuit } = setup();
    stores.push(store);
    let releaseDiscovery!: (queues: QueueInfo[]) => void;
    deps.discoverQueues = vi.fn(
      () =>
        new Promise<QueueInfo[]>((resolve) => {
          releaseDiscovery = resolve;
        }),
    );

    const refreshing = store.refresh();
    const { lastFrame } = render(<App store={store} onQuit={onQuit} />);
    await flush();
    expect(lastFrame()).toContain('Discovering queues on redis://localhost:6379');
    expect(lastFrame()).not.toContain('No BullMQ queues found');

    releaseDiscovery([{ name: 'emailQ', isPaused: false }]);
    await refreshing;
    await flush();
    expect(lastFrame()).toContain('emailQ');
    expect(lastFrame()).not.toContain('Discovering queues');
  });

  it('shows the empty state only once discovery has actually found nothing', async () => {
    const { deps, store, onQuit } = setup();
    stores.push(store);
    deps.discoverQueues = vi.fn(async () => []);

    await store.refresh();
    const { lastFrame } = render(<App store={store} onQuit={onQuit} />);
    await flush();
    expect(lastFrame()).toContain('No BullMQ queues found on redis://localhost:6379');
    expect(lastFrame()).not.toContain('Discovering queues');
  });
});

describe('App: stack navigation', () => {
  it('renders the full-width queue view and enters a selected queue', async () => {
    const { stdin, lastFrame, store } = await mount();
    expect(lastFrame()).toContain('Queue');
    expect(lastFrame()).toContain('Waiting');
    expect(lastFrame()).toContain('emailQ');
    expect(lastFrame()).toContain('smsQ');

    stdin.write('\r');
    await flush();
    expect(store.getSnapshot().currentView).toEqual({ kind: 'jobs', queueName: 'emailQ' });
    expect(store.getSnapshot().tab).toBe('delayed');
    expect(lastFrame()).toContain('[Delayed]');
    expect(lastFrame()).toContain('Queues > emailQ');
    expect(lastFrame()).not.toContain('smsQ');
  });

  it('pushes detail and pops it with Esc and h', async () => {
    const { stdin, lastFrame, store } = await mount();
    stdin.write('\r');
    await flush();
    stdin.write('3');
    await flush();
    stdin.write('\r');
    await flush();
    expect(store.getSnapshot().currentView).toEqual({
      kind: 'detail',
      queueName: 'emailQ',
      jobId: 'active-1',
    });
    expect(lastFrame()).toContain('recipient');

    stdin.write('\u001B');
    await flush();
    expect(store.getSnapshot().currentView.kind).toBe('jobs');
    stdin.write('h');
    await flush();
    expect(store.getSnapshot().currentView.kind).toBe('queues');
  });

  it('filters in the job view and switches status with numeric keys', async () => {
    const { stdin, store } = await mount();
    stdin.write('\r');
    await flush();
    stdin.write('4');
    await flush();
    expect(store.getSnapshot().tab).toBe('failed');
    expect(store.getSnapshot().selectedJobId).toBe('failed-1');

    stdin.write('/');
    await flush();
    stdin.write('failed');
    await flush();
    expect(store.getSnapshot().search.query).toBe('failed');
    stdin.write('\u001B');
    await flush();
    expect(store.getSnapshot().search.query).toBe('');
  });
});

describe('App: entering a queue', () => {
  it('shows the tab counts straight away, from the queue table, while the job page loads', async () => {
    const { deps, stdin, lastFrame } = await mount();
    // Every emailQ status holds exactly one job in this fixture, so the
    // counts the queue table already fetched render as `(1)` in each of the
    // tab row's 6-wide slots.
    expect(lastFrame()).toContain('emailQ');

    // Hang the job-page fetch: whatever the tab row shows now can only have
    // come from what was already known before Enter was pressed.
    deps.fetchJobPage = vi.fn(() => new Promise<JobPage>(() => {}));

    stdin.write('\r');
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('[Delayed]   (1)');
    expect(frame).toContain('Waiting');
    // The blank-slot rendering (`Tabs` with `counts == null`) would put six
    // spaces where the count is.
    expect(frame).not.toContain('[Delayed]      ');
  });
});

describe('App: contextual actions', () => {
  it('confirms deletion from the job view before acting', async () => {
    const { deps, stdin, store } = await mount();
    stdin.write('\r');
    await flush();
    stdin.write('3');
    await flush();
    stdin.write('D');
    await flush();
    expect(store.getSnapshot().confirmDeleteJobId).toBe('active-1');
    expect(deps.actions.delete).not.toHaveBeenCalled();

    stdin.write('y');
    await flush();
    expect(deps.actions.delete).toHaveBeenCalledWith('emailQ', 'active-1');
  });

  it('copies the detail data and keeps q global', async () => {
    const { deps, onQuit, stdin } = await mount();
    stdin.write('\r');
    await flush();
    stdin.write('3');
    await flush();
    stdin.write('\r');
    await flush();
    stdin.write('c');
    await flush();
    expect(deps.copyToClipboard).toHaveBeenCalledWith('{\n  "recipient": "test@example.com"\n}');

    stdin.write('q');
    await flush();
    expect(onQuit).toHaveBeenCalledOnce();
  });
});

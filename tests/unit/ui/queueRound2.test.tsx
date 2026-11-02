import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardStore, type StoreDeps } from '../../../src/core/store.js';
import type { ActionResult, JobStatus, QueueInfo } from '../../../src/core/types.js';
import { App } from '../../../src/ui/App.js';

// Round-2 probes (issue #8): connection errors while an input is open,
// recovery, `q` on the error and empty screens, and null-selection refresh
// volume. Real refresh failures are driven through `discoverQueues`, not just
// `onConnectionStatus`, so the runRefresh catch path is exercised.

const zero = (p: Partial<Record<JobStatus, number>> = {}): Record<JobStatus, number> => ({
  delayed: 0,
  waiting: 0,
  active: 0,
  failed: 0,
  completed: 0,
  ...p,
});

const counts: Record<string, Record<JobStatus, number>> = {
  alpha: zero({ failed: 1 }),
  beta: zero({ failed: 9 }),
  queueX: zero({ failed: 5 }),
};

const stores: DashboardStore[] = [];
const flush = () => vi.advanceTimersByTimeAsync(0);
const ALL = ['alpha', 'beta', 'queueX'];

interface Harness {
  down: boolean;
  names: string[];
}

async function mount() {
  const h: Harness = { down: false, names: [...ALL] };
  const deps: StoreDeps = {
    discoverQueues: vi.fn(async (): Promise<QueueInfo[]> => {
      if (h.down) {
        throw new Error('ECONNREFUSED');
      }
      return h.names.map((name) => ({ name, isPaused: false }));
    }),
    fetchQueueCounts: vi.fn(async (name: string) => counts[name] ?? zero()),
    fetchJobPage: vi.fn(async (name: string) => ({
      jobs: [],
      totalCount: 0,
      page: 0,
      pageCount: 1,
      counts: counts[name] ?? zero(),
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
    },
    syncRegistry: vi.fn(async () => {}),
  };
  const store = new DashboardStore(deps, { redisUrl: 'redis://x' });
  stores.push(store);
  await store.refresh();
  const onQuit = vi.fn();
  const instance = render(<App store={store} onQuit={onQuit} />);
  await flush();
  return { h, deps, store, onQuit, ...instance };
}

async function press(stdin: { write(s: string): void }, input: string) {
  stdin.write(input);
  await flush();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
  vi.useRealTimers();
});

describe('round 2: connection error with an input open, then recovery', () => {
  it('a real refresh failure closes the queue filter, keeps the query, and q quits', async () => {
    const { h, store, stdin, onQuit } = await mount();
    await press(stdin, '/');
    await press(stdin, 'al');
    h.down = true;
    await store.refresh();
    await flush();
    expect(store.getSnapshot().connection.state).toBe('error');
    expect(store.getSnapshot().queueFilter).toEqual({ active: false, query: 'al' });
    await press(stdin, 'q');
    expect(onQuit).toHaveBeenCalledOnce();
  });

  it('after recovery, / resumes the kept query and keeps filtering', async () => {
    const { h, store, stdin, lastFrame } = await mount();
    await press(stdin, '/');
    await press(stdin, 'al');
    h.down = true;
    await store.refresh();
    await flush();
    h.down = false;
    await store.refresh();
    await flush();
    expect(store.getSnapshot().connection.state).toBe('ready');
    expect(store.getSnapshot().queueFilter).toEqual({ active: false, query: 'al' });
    expect(lastFrame()).toContain('(filtered)');

    await press(stdin, '/');
    expect(store.getSnapshot().queueFilter).toEqual({ active: true, query: 'al' });
    expect(lastFrame()).toContain('/ al▌');
    await press(stdin, 'p');
    expect(store.getSnapshot().queueFilter.query).toBe('alp');
  });

  it('a connection-status error closes the job search; recovery via ready keeps its query', async () => {
    const { store, stdin } = await mount();
    await press(stdin, '\r');
    await press(stdin, '/');
    await press(stdin, 'ab');
    store.onConnectionStatus({ state: 'error', url: 'redis://x', message: 'boom' });
    await flush();
    expect(store.getSnapshot().search).toEqual({ active: false, query: 'ab' });
    store.onConnectionStatus({ state: 'ready' });
    await flush();
    await press(stdin, '/');
    expect(store.getSnapshot().search).toEqual({ active: true, query: 'ab' });
  });
});

describe('round 2: q on the error and empty screens with no input open', () => {
  it('quits from the connection error screen', async () => {
    const { h, store, stdin, onQuit } = await mount();
    h.down = true;
    await store.refresh();
    await flush();
    expect(store.getSnapshot().connection.state).toBe('error');
    await press(stdin, 'q');
    expect(onQuit).toHaveBeenCalledOnce();
  });

  it('quits from the empty-queues state', async () => {
    const { h, store, stdin, onQuit } = await mount();
    h.names = [];
    await store.refresh();
    await flush();
    expect(store.getSnapshot().queues).toEqual([]);
    await press(stdin, 'q');
    expect(onQuit).toHaveBeenCalledOnce();
  });
});

describe('round 2: null-selection refresh does not loop', () => {
  it('one discovery per change while the selection is null, none once it stays null', async () => {
    const { deps, store, stdin } = await mount();
    await press(stdin, '/');
    await vi.advanceTimersByTimeAsync(0);
    const base = vi.mocked(deps.discoverQueues).mock.calls.length;

    // The first 'z' hides every queue: alpha -> null, exactly one refresh.
    await press(stdin, 'z');
    await vi.advanceTimersByTimeAsync(100);
    expect(store.getSnapshot().selectedQueueName).toBeNull();
    const afterNull = vi.mocked(deps.discoverQueues).mock.calls.length;
    expect(afterNull - base).toBe(1);

    // Still null: a further 'z' must not refresh at all.
    await press(stdin, 'z');
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.mocked(deps.discoverQueues).mock.calls.length - afterNull).toBe(0);
    expect(store.getSnapshot().selectedQueueName).toBeNull();
  });

  it('a single null-selection change does not spawn a second refresh', async () => {
    const { deps, store } = await mount();
    store.openQueueFilter();
    const base = vi.mocked(deps.discoverQueues).mock.calls.length;
    store.setQueueFilterQuery('nomatch');
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.mocked(deps.discoverQueues).mock.calls.length - base).toBe(1);
    expect(store.getSnapshot().selectedQueueName).toBeNull();
  });
});

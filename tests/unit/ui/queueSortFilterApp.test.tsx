import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardStore, type StoreDeps } from '../../../src/core/store.js';
import type { ActionResult, JobStatus } from '../../../src/core/types.js';
import { App } from '../../../src/ui/App.js';

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
let discovered: string[] = [];
const flush = () => vi.advanceTimersByTimeAsync(0);

async function mount() {
  const deps: StoreDeps = {
    discoverQueues: vi.fn(async () => discovered.map((name) => ({ name, isPaused: false }))),
    fetchQueueCounts: vi.fn(async (name: string) => counts[name]),
    fetchJobPage: vi.fn(async (name: string) => ({
      jobs: [],
      totalCount: 0,
      page: 0,
      pageCount: 1,
      counts: counts[name],
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
  return { deps, store, onQuit, ...instance };
}

async function press(stdin: { write(s: string): void }, input: string) {
  stdin.write(input);
  await flush();
}

const rowOrder = (frame: string | undefined) =>
  ['alpha', 'beta', 'queueX']
    .map((n) => ({ n, i: (frame ?? '').indexOf(n) }))
    .filter((x) => x.i >= 0)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.n);

beforeEach(() => {
  vi.useFakeTimers();
  discovered = ['alpha', 'beta', 'queueX'];
});
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
  vi.useRealTimers();
});

describe('queue list sort and filter (App)', () => {
  it('shows the sort in the breadcrumb and reorders rows on s', async () => {
    const { lastFrame, stdin } = await mount();
    expect(lastFrame()).toContain('Queues · sorted by name');
    expect(rowOrder(lastFrame())).toEqual(['alpha', 'beta', 'queueX']);
    await press(stdin, 's');
    await press(stdin, 's');
    expect(lastFrame()).toContain('Queues · sorted by failed');
    expect(rowOrder(lastFrame())).toEqual(['beta', 'queueX', 'alpha']);
  });

  it('lists s and / in the legend', async () => {
    const { lastFrame } = await mount();
    expect(lastFrame()).toContain('<s>');
    expect(lastFrame()).toContain('Sort');
    expect(lastFrame()).toContain('Filter');
  });

  it('filters rows while typing, keeps on Enter, clears on Esc', async () => {
    const { lastFrame, stdin, store } = await mount();
    await press(stdin, '/');
    await press(stdin, 'B');
    expect(lastFrame()).toContain('/ B▌');
    expect(rowOrder(lastFrame())).toEqual(['beta']);
    expect(lastFrame()).toContain('1 of 3 queues');

    await press(stdin, '\r');
    expect(lastFrame()).toContain('(filtered)');
    expect(rowOrder(lastFrame())).toEqual(['beta']);

    await press(stdin, '\u001b');
    await vi.advanceTimersByTimeAsync(50);
    expect(store.getSnapshot().queueFilter).toEqual({ active: false, query: '' });
    expect(rowOrder(lastFrame())).toEqual(['alpha', 'beta', 'queueX']);
  });

  it('Backspace edits the query', async () => {
    const { stdin, store } = await mount();
    await press(stdin, '/');
    await press(stdin, 'be');
    await press(stdin, '\u007f');
    expect(store.getSnapshot().queueFilter.query).toBe('b');
  });

  it('treats q, s, p, D, r and H as literal characters while typing', async () => {
    const { stdin, store, onQuit, deps } = await mount();
    await press(stdin, '/');
    for (const ch of ['q', 's', 'p', 'D', 'r', 'H']) {
      await press(stdin, ch);
    }
    expect(onQuit).not.toHaveBeenCalled();
    expect(store.getSnapshot().queueFilter.query).toBe('qspDrH');
    expect(store.getSnapshot().queueSort).toBe('name');
    expect(deps.actions.togglePause).not.toHaveBeenCalled();
  });

  it('filters names containing q', async () => {
    const { lastFrame, stdin } = await mount();
    await press(stdin, '/');
    await press(stdin, 'queue');
    expect(rowOrder(lastFrame())).toEqual(['queueX']);
  });

  it('shows "No queues match" when nothing matches', async () => {
    const { lastFrame, stdin } = await mount();
    await press(stdin, '/');
    await press(stdin, 'zzz');
    expect(lastFrame()).toContain('No queues match "zzz"');
    expect(rowOrder(lastFrame())).toEqual([]);
  });

  it('Esc at the root clears an accepted filter; otherwise it is a no-op; q quits when closed', async () => {
    const { stdin, store, onQuit } = await mount();
    await press(stdin, '\u001b');
    expect(store.getSnapshot().currentView.kind).toBe('queues');
    await press(stdin, '/');
    await press(stdin, 'a');
    await press(stdin, '\r');
    await press(stdin, '\u001b');
    await vi.advanceTimersByTimeAsync(50);
    expect(store.getSnapshot().queueFilter.query).toBe('');
    await press(stdin, 'q');
    expect(onQuit).toHaveBeenCalledOnce();
  });

  it('arrows walk the visible rows and are inert while typing', async () => {
    const { stdin, store } = await mount();
    await press(stdin, 's');
    await press(stdin, 's');
    await press(stdin, 's'); // total? name->total->failed->waiting
    await press(stdin, 's'); // active
    await press(stdin, 's'); // delayed
    await press(stdin, 's'); // name
    await press(stdin, '\u001b[B');
    expect(store.getSnapshot().selectedQueueName).toBe('beta');
    await press(stdin, '/');
    await press(stdin, '\u001b[B');
    expect(store.getSnapshot().selectedQueueName).toBe('beta');
  });
});

describe('q still quits when an open input has no screen (error / empty queues)', () => {
  const error = { state: 'error', url: 'redis://x', message: 'boom' } as const;

  it('quits from the connection error screen with the queue filter open', async () => {
    const { stdin, store, onQuit } = await mount();
    await press(stdin, '/');
    expect(store.getSnapshot().queueFilter.active).toBe(true);
    store.onConnectionStatus(error);
    await flush();
    expect(store.getSnapshot().queueFilter).toEqual({ active: false, query: '' });
    await press(stdin, 'q');
    expect(onQuit).toHaveBeenCalledOnce();
  });

  it('quits from the connection error screen with the job search open', async () => {
    const { stdin, store, onQuit } = await mount();
    await press(stdin, '\r');
    await press(stdin, '/');
    await press(stdin, 'ab');
    expect(store.getSnapshot().search.active).toBe(true);
    store.onConnectionStatus(error);
    await flush();
    expect(store.getSnapshot().search).toEqual({ active: false, query: 'ab' });
    await press(stdin, 'q');
    expect(onQuit).toHaveBeenCalledOnce();
  });

  it('quits when the queues disappear while the filter is open', async () => {
    const { stdin, store, onQuit } = await mount();
    await press(stdin, '/');
    await press(stdin, 'al');
    discovered = [];
    await store.refresh();
    await flush();
    expect(store.getSnapshot().queueFilter).toEqual({ active: false, query: 'al' });
    await press(stdin, 'q');
    expect(onQuit).toHaveBeenCalledOnce();
  });
});

describe('inputs cannot be opened on screens that do not show them', () => {
  const error = { state: 'error', url: 'redis://x', message: 'boom' } as const;

  it('empty state: / then q quits and no input opens', async () => {
    discovered = [];
    const { stdin, store, onQuit } = await mount();
    await press(stdin, '/');
    expect(store.getSnapshot().queueFilter.active).toBe(false);
    await press(stdin, 'q');
    expect(onQuit).toHaveBeenCalledOnce();
  });

  it('error screen: / then q quits and no input opens', async () => {
    const { stdin, store, onQuit } = await mount();
    store.onConnectionStatus(error);
    await flush();
    await press(stdin, '/');
    expect(store.getSnapshot().queueFilter.active).toBe(false);
    await press(stdin, 'q');
    expect(onQuit).toHaveBeenCalledOnce();
  });

  it('error screen inside a job list: / then q quits and no search opens', async () => {
    const { stdin, store, onQuit } = await mount();
    await press(stdin, '\r');
    store.onConnectionStatus(error);
    await flush();
    await press(stdin, '/');
    expect(store.getSnapshot().search.active).toBe(false);
    await press(stdin, 'q');
    expect(onQuit).toHaveBeenCalledOnce();
  });

  it('loading screen: / then q quits and no input opens', async () => {
    const { deps, onQuit } = await mount();
    const fresh = new DashboardStore(deps, { redisUrl: 'redis://x' });
    stores.push(fresh);
    const { stdin } = render(<App store={fresh} onQuit={onQuit} />);
    await flush();
    await press(stdin, '/');
    expect(fresh.getSnapshot().queueFilter.active).toBe(false);
    await press(stdin, 'q');
    expect(onQuit).toHaveBeenCalledOnce();
  });
});

describe('queue metrics row (App)', () => {
  it('shows totals across all queues and — for throughput on the queue view', async () => {
    const { lastFrame } = await mount();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Total 0 delayed · 0 waiting · 0 active · 15 failed · 0 done');
    expect(frame).toContain('Throughput — done');
    // Directly under the breadcrumb, above the table header.
    expect(frame.indexOf('Total 0 delayed')).toBeLessThan(frame.indexOf('Delayed'));
  });

  it('keeps the totals across all queues while the list is filtered', async () => {
    const { lastFrame, stdin } = await mount();
    await press(stdin, '/');
    await press(stdin, 'alp');
    expect(rowOrder(lastFrame())).toEqual(['alpha']);
    expect(lastFrame()).toContain('15 failed');
  });

  it('is not shown inside a queue', async () => {
    const { lastFrame, stdin } = await mount();
    await press(stdin, '\r');
    expect(lastFrame()).not.toContain('Throughput');
  });
});

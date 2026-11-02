import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardStore, type StoreDeps } from '../../../src/core/store.js';
import type { ActionResult, JobStatus } from '../../../src/core/types.js';
import { App } from '../../../src/ui/App.js';

// Keymap probes for the queue-list sort/filter paths that the implementer's
// App tests don't reach (useKeymap.ts coverage gaps). Kept in a separate file.

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

async function mount() {
  const deps: StoreDeps = {
    discoverQueues: vi.fn(async () =>
      ['alpha', 'beta', 'queueX'].map((name) => ({ name, isPaused: false })),
    ),
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

const UP = '\u001b[A';
const DOWN = '\u001b[B';
const ESC = '\u001b';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
  vi.useRealTimers();
});

describe('queue keymap edge cases', () => {
  it('Up arrow walks back up the visible list', async () => {
    const { stdin, store } = await mount();
    await press(stdin, DOWN);
    await press(stdin, DOWN);
    expect(store.getSnapshot().selectedQueueName).toBe('queueX');
    await press(stdin, UP);
    expect(store.getSnapshot().selectedQueueName).toBe('beta');
    await press(stdin, UP);
    await press(stdin, UP);
    expect(store.getSnapshot().selectedQueueName).toBe('alpha');
  });

  it('Esc while typing in the filter closes it and clears the query', async () => {
    const { stdin, store } = await mount();
    await press(stdin, '/');
    await press(stdin, 'be');
    expect(store.getSnapshot().queueFilter).toEqual({ active: true, query: 'be' });
    await press(stdin, ESC);
    await vi.advanceTimersByTimeAsync(50);
    expect(store.getSnapshot().queueFilter).toEqual({ active: false, query: '' });
  });

  it('p and D act on the visible selection after a filter hides the previous one', async () => {
    const { stdin, store, deps } = await mount();
    await press(stdin, DOWN); // beta
    await press(stdin, '/');
    await press(stdin, 'queue');
    await press(stdin, '\r'); // accept; selection moves to queueX
    expect(store.getSnapshot().selectedQueueName).toBe('queueX');
    await press(stdin, 'p');
    expect(deps.actions.togglePause).toHaveBeenCalledWith('queueX');
    expect(deps.actions.togglePause).not.toHaveBeenCalledWith('beta');
    await press(stdin, 'D');
    expect(store.getSnapshot().confirmDrain).toBe(true);
    await press(stdin, 'n');
    expect(store.getSnapshot().confirmDrain).toBe(false);
    expect(deps.actions.drain).not.toHaveBeenCalled();
  });

  it('Enter with no matching queue does not leave the root view', async () => {
    const { stdin, store } = await mount();
    await press(stdin, '/');
    await press(stdin, 'zzz');
    await press(stdin, '\r');
    await press(stdin, '\r');
    expect(store.getSnapshot().currentView.kind).toBe('queues');
  });

  it('q is literal in the job search input too', async () => {
    const { stdin, store, onQuit } = await mount();
    await press(stdin, '\r'); // enter alpha's job list
    expect(store.getSnapshot().currentView.kind).toBe('jobs');
    await press(stdin, '/');
    await press(stdin, 'q');
    expect(onQuit).not.toHaveBeenCalled();
    expect(store.getSnapshot().search.query).toBe('q');
  });

  it('an accepted queue filter survives Enter into a queue and Esc back out', async () => {
    const { stdin, store, lastFrame } = await mount();
    await press(stdin, '/');
    await press(stdin, 'be');
    await press(stdin, '\r');
    expect(store.getSnapshot().selectedQueueName).toBe('beta');
    await press(stdin, '\r');
    expect(store.getSnapshot().currentView.kind).toBe('jobs');
    await press(stdin, ESC);
    expect(store.getSnapshot().currentView.kind).toBe('queues');
    expect(store.getSnapshot().queueFilter).toEqual({ active: false, query: 'be' });
    expect(lastFrame()).toContain('(filtered)');
    expect(lastFrame()).not.toContain('queueX');
  });

  it('H from a job list returns to the root with the queue filter intact', async () => {
    const { stdin, store } = await mount();
    await press(stdin, '/');
    await press(stdin, 'be');
    await press(stdin, '\r');
    await press(stdin, '\r');
    expect(store.getSnapshot().currentView.kind).toBe('jobs');
    await press(stdin, 'H');
    expect(store.getSnapshot().currentView.kind).toBe('queues');
    expect(store.getSnapshot().queueFilter.query).toBe('be');
  });
});

import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardStore, type StoreDeps } from '../../../src/core/store.js';
import type { ActionResult, JobStatus } from '../../../src/core/types.js';
import { App } from '../../../src/ui/App.js';

// A real 80x24 terminal: App gets a fixed height and an 78-column content width.
vi.mock('../../../src/ui/hooks/useTerminalDimensions.js', () => ({
  useTerminalDimensions: () => ({ columns: 80, rows: 24 }),
}));

const zero = (p: Partial<Record<JobStatus, number>> = {}): Record<JobStatus, number> => ({
  delayed: 0,
  waiting: 0,
  active: 0,
  failed: 0,
  completed: 0,
  ...p,
});

const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
const counts: Record<string, Record<JobStatus, number>> = Object.fromEntries(
  names.map((name, i) => [name, zero({ waiting: i, failed: i * 2, completed: i * 100 })]),
);

const stores: DashboardStore[] = [];
const flush = () => vi.advanceTimersByTimeAsync(0);

async function mount() {
  const deps: StoreDeps = {
    discoverQueues: vi.fn(async () => names.map((name) => ({ name, isPaused: false }))),
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
  const store = new DashboardStore(deps, { redisUrl: 'redis://localhost:6379' });
  stores.push(store);
  await store.refresh();
  const instance = render(<App store={store} onQuit={vi.fn()} />);
  await flush();
  return { store, ...instance };
}

const lines = (frame: string | undefined) => (frame ?? '').split('\n');
const lineOf = (frame: string | undefined, needle: string) =>
  lines(frame).findIndex((line) => line.includes(needle));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
  vi.useRealTimers();
});

describe('queue metrics row in an 80x24 terminal', () => {
  it('fits on one line with the table and footer still on screen', async () => {
    const { lastFrame } = await mount();
    const frame = lastFrame();
    expect(lines(frame)).toHaveLength(24);
    const row = lineOf(frame, 'All 0 dly');
    expect(row).toBeGreaterThan(-1);
    expect(lines(frame)[row]).toContain('All 0 dly · 10 wait · 0 act · 20 fail · 1000 done');
    expect(lines(frame)[row]).toContain('— done · — fail');
    expect(lines(frame)[row + 1]).not.toContain('fail');
    for (const name of names) {
      expect(frame).toContain(name);
    }
    expect(frame).toContain('Delayed');
    expect(frame).toContain('localhost:6379');
  });

  it('sits on the line the tab row takes in the jobs view, so the body starts in the same place', async () => {
    const { lastFrame, stdin, store } = await mount();
    const metricsRow = lineOf(lastFrame(), 'All 0 dly');
    expect(lineOf(lastFrame(), 'Delayed')).toBe(metricsRow + 2);
    stdin.write('\r');
    await flush();
    expect(store.getSnapshot().currentView.kind).toBe('jobs');
    expect(lineOf(lastFrame(), '[Delayed]')).toBe(metricsRow);
  });
});

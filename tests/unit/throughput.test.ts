import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THROUGHPUT_WINDOW_MS,
  formatRate,
  sumCounts,
  ThroughputTracker,
} from '../../src/core/throughput.js';
import type { JobStatus } from '../../src/core/types.js';

type Counts = Record<JobStatus, number>;

const zero = (p: Partial<Counts> = {}): Counts => ({
  delayed: 0,
  waiting: 0,
  active: 0,
  failed: 0,
  completed: 0,
  ...p,
});

const map = (entries: Record<string, Partial<Counts>>) =>
  new Map(Object.entries(entries).map(([name, c]) => [name, zero(c)]));

describe('sumCounts', () => {
  it('sums every status over the given names', () => {
    const counts = map({
      a: { delayed: 1, waiting: 2, active: 3, failed: 4, completed: 5 },
      b: { delayed: 10, waiting: 20, active: 30, failed: 40, completed: 50 },
    });
    expect(sumCounts(['a', 'b'], counts)).toEqual({
      delayed: 11,
      waiting: 22,
      active: 33,
      failed: 44,
      completed: 55,
    });
  });

  it('ignores cached queues that are not in the name list, and treats missing counts as 0', () => {
    const counts = map({ a: { failed: 1 }, gone: { failed: 100 } });
    expect(sumCounts(['a', 'notYetCounted'], counts)).toEqual(zero({ failed: 1 }));
  });

  it('is all zeros with no queues', () => {
    expect(sumCounts([], new Map())).toEqual(zero());
  });
});

describe('ThroughputTracker', () => {
  it('has no rate before any sample, or after a single one', () => {
    const tracker = new ThroughputTracker();
    expect(tracker.rate()).toBeNull();
    tracker.record(0, ['a'], map({ a: { completed: 100 } }));
    expect(tracker.rate()).toBeNull();
  });

  it('computes per-minute rates from the change between two samples', () => {
    const tracker = new ThroughputTracker();
    tracker.record(0, ['a', 'b'], map({ a: { completed: 100, failed: 5 }, b: { completed: 0 } }));
    tracker.record(
      30_000,
      ['a', 'b'],
      map({ a: { completed: 110, failed: 6 }, b: { completed: 5 } }),
    );
    // 15 completed and 1 failed in 30s.
    expect(tracker.rate()).toEqual({ completedPerMin: 30, failedPerMin: 2 });
  });

  it('returns null when the samples are not a positive time apart', () => {
    const tracker = new ThroughputTracker();
    tracker.record(1000, ['a'], map({ a: { completed: 1 } }));
    tracker.record(1000, ['a'], map({ a: { completed: 5 } }));
    expect(tracker.rate()).toBeNull();
  });

  it('treats a dropping counter (clean, drain, retry) as 0 for that interval, never negative', () => {
    const tracker = new ThroughputTracker();
    tracker.record(0, ['a'], map({ a: { completed: 1000, failed: 50 } }));
    tracker.record(60_000, ['a'], map({ a: { completed: 0, failed: 0 } }));
    expect(tracker.rate()).toEqual({ completedPerMin: 0, failedPerMin: 0 });
  });

  it('recovers after a reset: the next interval counts from the new, lower baseline', () => {
    const tracker = new ThroughputTracker(60_000);
    tracker.record(0, ['a'], map({ a: { completed: 1000 } }));
    tracker.record(60_000, ['a'], map({ a: { completed: 0 } }));
    tracker.record(120_000, ['a'], map({ a: { completed: 30 } }));
    // The window now spans 60s..120s: 30 jobs in one minute.
    expect(tracker.rate()?.completedPerMin).toBe(30);
  });

  it("doesn't let one queue's reset hide another queue's growth", () => {
    const tracker = new ThroughputTracker();
    tracker.record(0, ['a', 'b'], map({ a: { completed: 500 }, b: { completed: 0 } }));
    tracker.record(60_000, ['a', 'b'], map({ a: { completed: 0 }, b: { completed: 12 } }));
    expect(tracker.rate()?.completedPerMin).toBe(12);
  });

  it("doesn't count a newly discovered queue's backlog as throughput", () => {
    const tracker = new ThroughputTracker();
    tracker.record(0, ['a'], map({ a: { completed: 10 } }));
    tracker.record(
      60_000,
      ['a', 'new'],
      map({ a: { completed: 13 }, new: { completed: 9000, failed: 400 } }),
    );
    expect(tracker.rate()).toEqual({ completedPerMin: 3, failedPerMin: 0 });
  });

  it("doesn't count a queue whose counts land for the first time", () => {
    const tracker = new ThroughputTracker();
    tracker.record(0, ['a', 'slow'], map({ a: { completed: 10 } }));
    tracker.record(60_000, ['a', 'slow'], map({ a: { completed: 10 }, slow: { completed: 777 } }));
    expect(tracker.rate()?.completedPerMin).toBe(0);
  });

  it('gives a queue that disappears and reappears a fresh baseline', () => {
    const tracker = new ThroughputTracker();
    tracker.record(0, ['a'], map({ a: { completed: 10 } }));
    tracker.record(30_000, [], map({ a: { completed: 10 } }));
    tracker.record(60_000, ['a'], map({ a: { completed: 500 } }));
    expect(tracker.rate()?.completedPerMin).toBe(0);
  });

  it('averages over the window, so samples close together give a steady rate', () => {
    const tracker = new ThroughputTracker(60_000);
    tracker.record(0, ['a'], map({ a: { completed: 0 } }));
    tracker.record(30_000, ['a'], map({ a: { completed: 30 } }));
    // A navigation refreshes 100ms later with no new completions.
    tracker.record(30_100, ['a'], map({ a: { completed: 30 } }));
    expect(tracker.rate()?.completedPerMin).toBeCloseTo((30 / 30_100) * 60_000);
  });

  it('drops samples older than the window, keeping one baseline at its start', () => {
    const tracker = new ThroughputTracker(60_000);
    tracker.record(0, ['a'], map({ a: { completed: 0 } }));
    // A burst in the first minute...
    tracker.record(10_000, ['a'], map({ a: { completed: 600 } }));
    tracker.record(60_000, ['a'], map({ a: { completed: 600 } }));
    // ...then nothing for a minute: the burst falls out of the window.
    tracker.record(120_000, ['a'], map({ a: { completed: 600 } }));
    expect(tracker.rate()?.completedPerMin).toBe(0);
  });

  it('defaults to a one-minute window', () => {
    expect(DEFAULT_THROUGHPUT_WINDOW_MS).toBe(60_000);
  });
});

describe('formatRate', () => {
  it.each([
    [0, '0'],
    [0.25, '0.3'],
    [2, '2.0'],
    [9.94, '9.9'],
    [10, '10'],
    [123.6, '124'],
  ])('formats %d as %s', (input, expected) => {
    expect(formatRate(input)).toBe(expected);
  });
});

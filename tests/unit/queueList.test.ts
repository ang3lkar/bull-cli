import { describe, expect, it } from 'vitest';
import { filterQueues, QUEUE_SORT_ORDER, sortQueues } from '../../src/core/queueList.js';
import type { JobStatus, QueueInfo } from '../../src/core/types.js';

const q = (name: string): QueueInfo => ({ name, isPaused: false });
const c = (p: Partial<Record<JobStatus, number>>): Record<JobStatus, number> => ({
  delayed: 0,
  waiting: 0,
  active: 0,
  failed: 0,
  completed: 0,
  ...p,
});
const names = (list: QueueInfo[]) => list.map((x) => x.name);

describe('sortQueues', () => {
  const queues = [q('b'), q('c'), q('a'), q('d')];
  const counts = new Map([
    ['a', c({ failed: 1, completed: 100 })],
    ['b', c({ failed: 5, waiting: 1, active: 9, delayed: 2 })],
    ['c', c({ failed: 5, waiting: 7 })],
    // 'd' has no counts yet
  ]);

  it('sorts by name ascending', () => {
    expect(names(sortQueues(queues, counts, 'name'))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('sorts failed descending, ties by name', () => {
    expect(names(sortQueues(queues, counts, 'failed'))).toEqual(['b', 'c', 'a', 'd']);
  });

  it('sorts waiting, active and delayed descending', () => {
    expect(names(sortQueues(queues, counts, 'waiting'))).toEqual(['c', 'b', 'a', 'd']);
    expect(names(sortQueues(queues, counts, 'active'))).toEqual(['b', 'a', 'c', 'd']);
    expect(names(sortQueues(queues, counts, 'delayed'))).toEqual(['b', 'a', 'c', 'd']);
  });

  it('total includes completed', () => {
    expect(names(sortQueues(queues, counts, 'total'))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('treats missing counts as 0', () => {
    expect(names(sortQueues(queues, new Map(), 'failed'))).toEqual(['a', 'b', 'c', 'd']);
    expect(names(sortQueues(queues, new Map([['c', c({ failed: 1 })]]), 'failed'))).toEqual([
      'c',
      'a',
      'b',
      'd',
    ]);
  });

  it('does not mutate its input', () => {
    const input = [q('b'), q('a')];
    sortQueues(input, counts, 'name');
    expect(names(input)).toEqual(['b', 'a']);
  });

  it('exposes the cycle order', () => {
    expect(QUEUE_SORT_ORDER).toEqual(['name', 'total', 'failed', 'waiting', 'active', 'delayed']);
  });
});

describe('filterQueues', () => {
  const queues = [q('emailQ'), q('SmsQueue'), q('billing')];
  it('matches case-insensitively by substring', () => {
    expect(names(filterQueues(queues, 'QUEUE'))).toEqual(['SmsQueue']);
    expect(names(filterQueues(queues, 'q'))).toEqual(['emailQ', 'SmsQueue']);
  });
  it('returns everything for an empty query', () => {
    expect(filterQueues(queues, '  ')).toBe(queues);
  });
});

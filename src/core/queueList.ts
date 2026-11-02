import type { JobStatus, QueueInfo } from './types.js';

/** Sort order of the root queue list; `name` is ascending, every count sort is descending. */
export type QueueSort = 'name' | 'total' | 'failed' | 'waiting' | 'active' | 'delayed';

/** Order `s` cycles through, wrapping from the last back to the first. */
export const QUEUE_SORT_ORDER: readonly QueueSort[] = [
  'name',
  'total',
  'failed',
  'waiting',
  'active',
  'delayed',
];

type Counts = Readonly<Record<JobStatus, number>>;

function countFor(counts: Counts | undefined, sort: Exclude<QueueSort, 'name'>): number {
  if (counts === undefined) {
    return 0;
  }
  if (sort === 'total') {
    return counts.delayed + counts.waiting + counts.active + counts.failed + counts.completed;
  }
  return counts[sort];
}

/**
 * Returns a sorted copy of `queues`. `name` sorts ascending (`localeCompare`,
 * like discovery); count sorts are descending with ties broken by name
 * ascending. A queue with no counts yet counts as 0. Pure; never mutates input.
 */
export function sortQueues(
  queues: readonly QueueInfo[],
  counts: ReadonlyMap<string, Counts>,
  sort: QueueSort,
): QueueInfo[] {
  const lookup = (name: string): Counts | undefined => counts.get(name);
  const byName = (a: QueueInfo, b: QueueInfo): number => a.name.localeCompare(b.name);
  if (sort === 'name') {
    return [...queues].sort(byName);
  }
  return [...queues].sort(
    (a, b) => countFor(lookup(b.name), sort) - countFor(lookup(a.name), sort) || byName(a, b),
  );
}

/** Case-insensitive substring match on the queue name; an empty/whitespace query returns everything. */
export function filterQueues(queues: QueueInfo[], query: string): QueueInfo[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === '') {
    return queues;
  }
  return queues.filter((queue) => queue.name.toLowerCase().includes(trimmed));
}

import type { JobStatus } from './types.js';

type Counts = Readonly<Record<JobStatus, number>>;

/** Job counts summed across queues. */
export type QueueTotals = Record<JobStatus, number>;

/** Completed and failed jobs per minute, across all queues. */
export interface Throughput {
  completedPerMin: number;
  failedPerMin: number;
}

/**
 * Sums `counts` over `names`. A name with no counts yet adds 0. Takes the
 * names rather than every entry of `counts` because the store's count cache
 * keeps entries for queues that have since disappeared.
 */
export function sumCounts(
  names: readonly string[],
  counts: ReadonlyMap<string, Counts>,
): QueueTotals {
  const totals: QueueTotals = { delayed: 0, waiting: 0, active: 0, failed: 0, completed: 0 };
  for (const name of names) {
    const queueCounts = counts.get(name);
    if (queueCounts === undefined) {
      continue;
    }
    totals.delayed += queueCounts.delayed;
    totals.waiting += queueCounts.waiting;
    totals.active += queueCounts.active;
    totals.failed += queueCounts.failed;
    totals.completed += queueCounts.completed;
  }
  return totals;
}

/** Default window the rate is averaged over. */
export const DEFAULT_THROUGHPUT_WINDOW_MS = 60_000;

interface Sample {
  at: number;
  /** Running sums of clamped per-queue increments; they never go down. */
  completed: number;
  failed: number;
}

/**
 * Turns successive count snapshots into completed and failed jobs per minute.
 *
 * BullMQ only exposes how many jobs are *in* each state, not how many have
 * ever passed through, so the rate is derived from how those counts grow
 * between polls. Each queue's growth is computed on its own and clamped at
 * 0, then summed:
 * - A counter that drops (a `clean`, an `obliterate`, failed jobs being
 *   retried) contributes 0 for that interval instead of a negative rate,
 *   and doesn't hide another queue's growth.
 * - A queue seen for the first time (newly discovered, or its counts just
 *   landed) only sets a baseline, so it doesn't register its whole backlog
 *   as one interval's throughput.
 *
 * The rate is averaged over the samples in the last `windowMs`, because a
 * navigation refreshes right away and two samples can be milliseconds apart.
 *
 * A queue whose jobs use `removeOnComplete` or `removeOnFail` keeps a flat
 * count, so its throughput reads as 0.
 */
export class ThroughputTracker {
  private readonly windowMs: number;
  private readonly lastCounts = new Map<string, { completed: number; failed: number }>();
  private samples: Sample[] = [];
  private completed = 0;
  private failed = 0;

  constructor(windowMs = DEFAULT_THROUGHPUT_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /** Records the counts of `names` as of `at`. */
  record(at: number, names: readonly string[], counts: ReadonlyMap<string, Counts>): void {
    const seen = new Set<string>();
    for (const name of names) {
      const queueCounts = counts.get(name);
      if (queueCounts === undefined) {
        continue;
      }
      seen.add(name);
      const previous = this.lastCounts.get(name);
      if (previous !== undefined) {
        this.completed += Math.max(0, queueCounts.completed - previous.completed);
        this.failed += Math.max(0, queueCounts.failed - previous.failed);
      }
      this.lastCounts.set(name, { completed: queueCounts.completed, failed: queueCounts.failed });
    }
    // A queue that disappears and comes back starts from a fresh baseline.
    for (const name of this.lastCounts.keys()) {
      if (!seen.has(name)) {
        this.lastCounts.delete(name);
      }
    }

    this.samples.push({ at, completed: this.completed, failed: this.failed });
    // Keep the newest sample at or before the window start as the baseline.
    while (this.samples.length > 2 && this.samples[1].at <= at - this.windowMs) {
      this.samples.shift();
    }
  }

  /** The current rate, or `null` until two samples a positive time apart exist. */
  rate(): Throughput | null {
    if (this.samples.length < 2) {
      return null;
    }
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const elapsed = last.at - first.at;
    if (elapsed <= 0) {
      return null;
    }
    return {
      completedPerMin: ((last.completed - first.completed) / elapsed) * 60_000,
      failedPerMin: ((last.failed - first.failed) / elapsed) * 60_000,
    };
  }
}

/** Formats a per-minute rate: one decimal below 10, a whole number from 10 up. */
export function formatRate(perMin: number): string {
  if (perMin > 0 && perMin < 10) {
    return perMin.toFixed(1);
  }
  return String(Math.round(perMin));
}

import type { Queue } from 'bullmq';
import { displayTimestamp, normalizeProgress } from './format.js';
import type { JobDetail, JobPage, JobStatus, JobSummary } from './types.js';

/** Jobs per page in the job list table (spec: 10 jobs per page). */
export const PAGE_SIZE = 10;

const COUNT_TYPES = ['active', 'waiting', 'paused', 'completed', 'failed', 'delayed'] as const;

/** All five status tabs, used to build the per-tab counts map from a single `getJobCounts` call. */
const ALL_STATUSES: JobStatus[] = ['active', 'waiting', 'completed', 'failed', 'delayed'];

/**
 * Total job count for a status tab. A paused queue holds its waiting jobs in
 * the `paused` bucket instead of `waiting` (bullmq moves the whole wait list
 * over on `queue.pause()`, and routes new jobs there while paused), so the
 * Waiting tab's total must fold both buckets together.
 */
function totalCountForStatus(counts: Record<string, number>, status: JobStatus): number {
  if (status === 'waiting') {
    // `?? 0` fallbacks are unreachable in practice: `counts` always comes
    // from `queue.getJobCounts(...COUNT_TYPES)`, which always includes
    // `waiting` and `paused` keys with numeric values. Kept only because
    // `getJobCounts`'s return type is an index signature (`{[k: string]:
    // number}`), so TS can't prove the keys are present.
    /* v8 ignore next */
    return (counts.waiting ?? 0) + (counts.paused ?? 0);
  }
  // Same defensive reasoning: `status` is always one of the 5 `JobStatus`
  // values, all of which are requested via `COUNT_TYPES` and therefore
  // always present on `counts`.
  /* v8 ignore next */
  return counts[status] ?? 0;
}

/** Fetches the five UI counts without loading any job rows. */
export async function fetchQueueCounts(queue: Queue): Promise<Record<JobStatus, number>> {
  const counts = await queue.getJobCounts(...COUNT_TYPES);
  return Object.fromEntries(
    ALL_STATUSES.map((status) => [status, totalCountForStatus(counts, status)]),
  ) as Record<JobStatus, number>;
}

function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(page, 0), pageCount - 1);
}

/**
 * Fetches one page of jobs for a status tab, newest first.
 *
 * Empirically verified against bullmq 5.79: requesting `queue.getJobs(
 * ['waiting'], ...)` automatically folds in the `paused` bucket too (bullmq's
 * internal `sanitizeJobTypes` appends `'paused'` whenever `'waiting'` is
 * requested) — since a queue's waiting jobs live in *either* the `wait` list
 * or the `paused` list but never both at once, concatenating per-type range
 * results (what bullmq does internally) still yields correct pagination
 * without duplicates or gaps.
 */
export async function fetchJobPage(
  queue: Queue,
  status: JobStatus,
  page: number,
): Promise<JobPage> {
  const counts = await fetchQueueCounts(queue);
  const totalCount = counts[status];
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const currentPage = clampPage(page, pageCount);

  const start = currentPage * PAGE_SIZE;
  const end = start + PAGE_SIZE - 1;

  const jobs = await queue.getJobs([status], start, end, false);

  const summaries: JobSummary[] = jobs
    .filter((job) => job != null)
    .map((job) => ({
      id: String(job.id),
      name: job.name,
      attemptsMade: job.attemptsMade,
      timestamp: displayTimestamp(job, status),
      progress: normalizeProgress(job.progress),
    }));

  return { jobs: summaries, totalCount, page: currentPage, pageCount, counts };
}

/**
 * Fetches full detail for a single job, or `null` if it no longer exists.
 *
 * `status` isn't a parameter here (unlike `fetchJobPage`) because
 * `JobDetail`/`JobSummary` don't carry a status field at all — only a
 * `timestamp`, and `displayTimestamp` only branches on completed/failed vs.
 * everything else. So we ask the job itself via `job.getState()` (accurate
 * even if the caller's cached tab selection is stale) and only need to know
 * whether it's finished, not its exact bullmq state.
 */
export async function getJobDetail(queue: Queue, jobId: string): Promise<JobDetail | null> {
  const job = await queue.getJob(jobId);
  if (!job) {
    return null;
  }

  const state = await job.getState();
  const finishedStatus: JobStatus | null =
    state === 'completed' || state === 'failed' ? state : null;
  const timestamp = displayTimestamp(job, finishedStatus ?? 'active');

  return {
    id: String(job.id),
    name: job.name,
    attemptsMade: job.attemptsMade,
    timestamp,
    progress: normalizeProgress(job.progress),
    data: job.data,
    returnvalue: job.returnvalue,
    // `?? []` fallback is unreachable via `queue.getJob`/`queue.getJobs`:
    // bullmq's own `Job.fromJSON` deserialization (`getTraces`) already
    // normalizes a missing/null stored stacktrace to `[]` before the `Job`
    // instance reaches this code. Kept only because the field's type is
    // `string[] | null` (its in-memory default before deserialization).
    /* v8 ignore next */
    stacktrace: job.stacktrace ?? [],
    opts: job.opts,
    timestamps: {
      created: job.timestamp,
      processed: job.processedOn ?? null,
      finished: job.finishedOn ?? null,
    },
    rawProgress: job.progress,
  };
}

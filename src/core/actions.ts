import type { Queue } from 'bullmq';
import type { ActionResult, RetryError, RetrySummary } from './types.js';

/**
 * Converts a caught error into a plain human-readable message — never a
 * stack trace (per spec's error-handling table: toasts show a message, not
 * a raw stack). Handles both `Error` instances (bullmq throws these, e.g.
 * `job.remove()` on a locked/active job) and non-`Error` throws (defensive;
 * bullmq doesn't throw these in practice, but nothing prevents a future
 * version — or the Lua-error path — from doing so).
 */
function toMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Retries a failed job (moves it back to `waiting`). Only valid for jobs
 * currently in the `failed` state — anything else (including a missing job)
 * comes back as `{ ok: false }` with a message suitable for the `r` key's
 * toast ("Retry job (failed jobs only)" per spec).
 */
export async function retryJob(queue: Queue, jobId: string): Promise<ActionResult> {
  try {
    const job = await queue.getJob(jobId);
    if (!job) {
      return { ok: false, message: `Job ${jobId} not found` };
    }

    const state = await job.getState();
    if (state !== 'failed') {
      return {
        ok: false,
        message: `Job ${jobId} is ${state}, not failed — only failed jobs can be retried`,
      };
    }

    await job.retry('failed');
    return { ok: true, info: `Job ${jobId} moved back to waiting` };
  } catch (err) {
    return { ok: false, message: toMessage(err) };
  }
}

/** Which failed jobs `retryFailedJobs` acts on. At most one filter applies. */
export interface RetryFailedOptions {
  /** Only this job (must currently be failed). */
  jobId?: string;
  /** Only jobs that failed at or after this epoch-millis time. */
  failedSince?: number;
  /** Count what would be retried without changing anything. */
  dryRun?: boolean;
}

/**
 * Retries failed jobs in bulk: all of them by default, one with `jobId`, or
 * the ones that failed since `failedSince`.
 *
 * - **All**: bullmq's `Queue.retryJobs()`, one Lua loop server-side. It
 *   returns nothing, so `matched` is the failed count read just before, and
 *   `retried` assumes all of them moved unless the call throws (then the
 *   failed count is re-read to work out how many did).
 * - **`failedSince`**: `retryJobs({ timestamp })` is an UPPER bound (it
 *   retries jobs that failed *before* it), the opposite of what's needed. The
 *   failed list is ordered by `finishedOn`, so the matching ids are
 *   collected newest-first (see `failedIdsSince`), then retried one by one.
 *   Collecting before retrying matters: each retry removes a job from the
 *   list being paged through, which would shift the pages and skip jobs.
 * - **`jobId`**: like `retryJob` above, but reported as a summary.
 */
export async function retryFailedJobs(
  queue: Queue,
  opts: RetryFailedOptions = {},
): Promise<RetrySummary> {
  const { jobId, failedSince, dryRun = false } = opts;
  try {
    if (jobId !== undefined) {
      return await retryOne(queue, jobId, dryRun);
    }
    if (failedSince !== undefined) {
      const ids = await failedIdsSince(queue, failedSince);
      return dryRun ? summary(ids.length) : await retryEach(queue, ids);
    }
    return await retryAll(queue, dryRun);
  } catch (err) {
    return summary(0, 0, [{ jobId: null, message: toMessage(err) }], 0);
  }
}

const FAILED_PAGE_SIZE = 200;

/**
 * Ids of failed jobs whose `finishedOn` is at or after `since`. bullmq
 * returns failed jobs newest-first, so paging stops at the first older job.
 */
async function failedIdsSince(queue: Queue, since: number): Promise<string[]> {
  // A Set, because new failures landing mid-scan go in at the top and push
  // older jobs down a page, so the same job can turn up on two pages.
  const ids = new Set<string>();
  for (let start = 0; ; start += FAILED_PAGE_SIZE) {
    const jobs = await queue.getFailed(start, start + FAILED_PAGE_SIZE - 1);
    for (const job of jobs) {
      // A job removed between the range read and the hash read comes back
      // empty; it can't be retried, so skip it.
      if (!job?.id) {
        continue;
      }
      if ((job.finishedOn ?? 0) < since) {
        return [...ids];
      }
      ids.add(job.id);
    }
    if (jobs.length < FAILED_PAGE_SIZE) {
      return [...ids];
    }
  }
}

/** `errored` defaults to one per error; the batch path overrides it (one error, many jobs). */
function summary(
  matched: number,
  retried = 0,
  errors: RetryError[] = [],
  errored = errors.length,
): RetrySummary {
  return { matched, retried, errored, errors };
}

/** A job that is missing or not failed matches nothing, and is reported as an error. */
async function retryOne(queue: Queue, jobId: string, dryRun: boolean): Promise<RetrySummary> {
  const job = await queue.getJob(jobId);
  const state = job ? await job.getState() : null;
  if (!job || state !== 'failed') {
    const message =
      state === null
        ? `Job ${jobId} not found`
        : `Job ${jobId} is ${state}, not failed — only failed jobs can be retried`;
    return summary(0, 0, [{ jobId, message }], 0);
  }
  if (dryRun) {
    return summary(1);
  }
  try {
    await job.retry('failed');
    return summary(1, 1);
  } catch (err) {
    return summary(1, 0, [{ jobId, message: toMessage(err) }]);
  }
}

async function retryEach(queue: Queue, ids: string[]): Promise<RetrySummary> {
  const errors: RetryError[] = [];
  for (const id of ids) {
    const result = await retryJob(queue, id);
    if (!result.ok) {
      errors.push({ jobId: id, message: result.message });
    }
  }
  return summary(ids.length, ids.length - errors.length, errors);
}

async function retryAll(queue: Queue, dryRun: boolean): Promise<RetrySummary> {
  const before = await queue.getFailedCount();
  if (dryRun || before === 0) {
    return summary(before, dryRun ? 0 : before);
  }
  try {
    await queue.retryJobs({ state: 'failed', timestamp: Date.now() });
    return summary(before, before);
  } catch (err) {
    const after = await queue.getFailedCount().catch(() => before);
    const retried = Math.max(0, before - after);
    return summary(before, retried, [{ jobId: null, message: toMessage(err) }], before - retried);
  }
}

/**
 * Removes a job entirely. bullmq throws if the job is currently locked by a
 * worker (i.e. active) — that's caught here and normalized rather than
 * allowed to escape.
 */
export async function deleteJob(queue: Queue, jobId: string): Promise<ActionResult> {
  try {
    const job = await queue.getJob(jobId);
    if (!job) {
      return { ok: false, message: `Job ${jobId} not found` };
    }

    await job.remove();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: `Could not delete job ${jobId}: ${toMessage(err)}` };
  }
}

/**
 * Promotes a delayed job to `waiting` immediately. Only valid for jobs
 * currently in the `delayed` state.
 */
export async function promoteJob(queue: Queue, jobId: string): Promise<ActionResult> {
  try {
    const job = await queue.getJob(jobId);
    if (!job) {
      return { ok: false, message: `Job ${jobId} not found` };
    }

    const state = await job.getState();
    if (state !== 'delayed') {
      return {
        ok: false,
        message: `Job ${jobId} is ${state}, not delayed — only delayed jobs can be promoted`,
      };
    }

    await job.promote();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: toMessage(err) };
  }
}

/**
 * How far in the future a duplicated job is scheduled. The point of `c`
 * (clone) is to park the copy under the Delayed tab so the user can inspect
 * it and `p`romote it when ready — not to have a worker snap it up
 * immediately — so the delay is deliberately long rather than "soon".
 */
export const DUPLICATE_DELAY_MS = 24 * 60 * 60 * 1000;

/**
 * Duplicates a job: adds a NEW job to the same queue with the same name,
 * payload (`data`), and options, scheduled `DUPLICATE_DELAY_MS` in the
 * future so it lands in the `delayed` bucket. Options that would tie the
 * clone back to the original (or make the add a no-op) are stripped:
 * - `jobId`: an explicit custom id would collide with the original — bullmq
 *   silently returns the EXISTING job for a duplicate id, so keeping it
 *   would make "duplicate" do nothing at all.
 * - `repeat`/`repeatJobKey`: cloning one instance of a repeatable job must
 *   not register a whole new repeat schedule (or point back at the
 *   original's repeat key).
 * - `deduplication` (and its deprecated `debounce` alias): would let the
 *   still-existing original suppress the clone for the dedup window.
 * - `timestamp`/`delay`: recomputed for the clone.
 */
export async function duplicateJob(queue: Queue, jobId: string): Promise<ActionResult> {
  try {
    const job = await queue.getJob(jobId);
    if (!job) {
      return { ok: false, message: `Job ${jobId} not found` };
    }

    const {
      jobId: _jobId,
      repeat: _repeat,
      repeatJobKey: _repeatJobKey,
      deduplication: _deduplication,
      debounce: _debounce,
      timestamp: _timestamp,
      delay: _delay,
      ...opts
    } = job.opts;
    const clone = await queue.add(job.name, job.data, { ...opts, delay: DUPLICATE_DELAY_MS });
    return { ok: true, info: `Job ${jobId} duplicated as delayed job ${clone.id}` };
  } catch (err) {
    return { ok: false, message: `Could not duplicate job ${jobId}: ${toMessage(err)}` };
  }
}

/** Pauses a queue: no new jobs move from `waiting` to `active`. */
export async function pauseQueue(queue: Queue): Promise<ActionResult> {
  try {
    await queue.pause();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: `Could not pause queue: ${toMessage(err)}` };
  }
}

/** Resumes a paused queue. */
export async function resumeQueue(queue: Queue): Promise<ActionResult> {
  try {
    await queue.resume();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: `Could not resume queue: ${toMessage(err)}` };
  }
}

/**
 * Flips a queue's pause state (the sidebar's `p` binding): resumes if
 * currently paused, pauses otherwise. `info` reports which way it went so
 * the UI can show a confirming toast.
 */
export async function togglePauseQueue(queue: Queue): Promise<ActionResult> {
  try {
    const paused = await queue.isPaused();
    if (paused) {
      await queue.resume();
      return { ok: true, info: 'Queue resumed' };
    }
    await queue.pause();
    return { ok: true, info: 'Queue paused' };
  } catch (err) {
    return { ok: false, message: `Could not toggle queue pause state: ${toMessage(err)}` };
  }
}

/**
 * Drains a queue: removes all `waiting` and `delayed` jobs. Leaves
 * `active`, `completed`, and `failed` jobs untouched — this is bullmq's
 * own `queue.drain()` semantics, not a full wipe. The confirmation prompt
 * for this destructive action is a UI-layer concern; this function just
 * performs the drain.
 */
export async function drainQueue(queue: Queue): Promise<ActionResult> {
  try {
    // bullmq's `drain(delayed = false)` only clears `waiting` by default —
    // pass `true` so delayed jobs are removed too (spec/task: drain empties
    // both waiting and delayed, leaving active/completed/failed alone).
    await queue.drain(true);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: `Could not drain queue: ${toMessage(err)}` };
  }
}

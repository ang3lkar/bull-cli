import type { JobSchedulerJson, Queue } from 'bullmq';
import { PAGE_SIZE } from './jobs.js';
import type { SchedulerDetail, SchedulerPage, SchedulerSummary } from './types.js';

function toSummary(raw: JobSchedulerJson): SchedulerSummary {
  return {
    key: raw.key,
    name: raw.name,
    pattern: raw.pattern ?? null,
    every: raw.every ?? null,
    tz: raw.tz ?? null,
    next: raw.next ?? null,
    iterationCount: raw.iterationCount ?? 0,
    limit: raw.limit ?? null,
  };
}

/** Total number of job schedulers on the queue (one ZCARD). */
export async function fetchSchedulerCount(queue: Queue): Promise<number> {
  return queue.getJobSchedulersCount();
}

/**
 * Fetches one page of job schedulers, soonest next run first (the repeat
 * zset's score is the next run time). Paging semantics match `fetchJobPage`.
 */
export async function fetchSchedulerPage(queue: Queue, page: number): Promise<SchedulerPage> {
  const totalCount = await queue.getJobSchedulersCount();
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const currentPage = Math.min(Math.max(page, 0), pageCount - 1);

  const start = currentPage * PAGE_SIZE;
  const raw = await queue.getJobSchedulers(start, start + PAGE_SIZE - 1, true);

  return {
    schedulers: raw.filter((scheduler) => scheduler != null).map(toSummary),
    totalCount,
    page: currentPage,
    pageCount,
  };
}

/**
 * Fetches full detail for one scheduler, or `null` if it no longer exists.
 * `nextJobId` is bullmq's `repeat:<id>:<nextMillis>` convention, but only
 * reported when that job really exists — the format is an implementation
 * detail, so it's confirmed with `getJob` rather than trusted. Next-job
 * lookup for old colon-format legacy repeatables is unsupported (null).
 */
export async function getSchedulerDetail(
  queue: Queue,
  key: string,
): Promise<SchedulerDetail | null> {
  const raw = await queue.getJobScheduler(key);
  // bullmq falls back to a key-derived object for ids containing `:` even
  // after the scheduler was removed; such a ghost has no next run, so a
  // missing `next` is treated as "gone".
  if (!raw || raw.next == null) {
    return null;
  }

  const candidate = `repeat:${raw.key}:${raw.next}`;
  const nextJobId = (await queue.getJob(candidate)) ? candidate : null;

  return {
    ...toSummary(raw),
    startDate: raw.startDate ?? null,
    endDate: raw.endDate ?? null,
    offset: raw.offset ?? null,
    template: { data: raw.template?.data, opts: raw.template?.opts },
    nextJobId,
  };
}

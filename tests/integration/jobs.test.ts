import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionOpts } from '../../src/config.js';
import { fetchJobPage, getJobDetail } from '../../src/core/jobs.js';
import {
  addDelayed,
  addWaiting,
  closeSeeded,
  type HeldActive,
  holdActive,
  makeCompleted,
  makeFailed,
  type SeededWorkerResult,
} from './helpers/seed.js';

const JOBS_DB = 2;
const connection: ConnectionOpts = { host: 'localhost', port: 6379, db: JOBS_DB };

let redis: Redis;
let queue: Queue;
let extraQueues: Queue[];
let held: HeldActive | undefined;

beforeAll(() => {
  redis = new Redis({ ...connection, maxRetriesPerRequest: null });
});

beforeEach(async () => {
  await redis.flushdb();
  queue = new Queue('jobsQ', { connection });
  extraQueues = [];
  held = undefined;
});

afterEach(async () => {
  // Release *before* closing: `worker.close()` waits for the currently
  // active job to finish, so an unreleased worker would hang here — the
  // exact failure mode this harness exists to avoid. Doing this in
  // `afterEach` (rather than inline at the end of the one test that uses
  // `holdActive`) means a failed assertion earlier in that test still gets
  // the worker closed instead of leaking a blocked connection.
  if (held) {
    held.release();
    await held.worker.close();
  }
  await queue.close();
  await Promise.all(extraQueues.map((q) => q.close()));
});

afterAll(() => {
  redis.disconnect();
});

describe('fetchJobPage', () => {
  it('returns waiting jobs', async () => {
    await addWaiting(queue, 3, 'wjob');

    const result = await fetchJobPage(queue, 'waiting', 0);

    expect(result.totalCount).toBe(3);
    expect(result.jobs).toHaveLength(3);
    expect(result.jobs.map((j) => j.name).sort()).toEqual(['wjob-0', 'wjob-1', 'wjob-2']);
    expect(result.counts.waiting).toBe(3);
    expect(result.counts).toEqual({ active: 0, waiting: 3, completed: 0, failed: 0, delayed: 0 });
  });

  it('returns delayed jobs', async () => {
    await addDelayed(queue, 2, 60_000, 'djob');

    const result = await fetchJobPage(queue, 'delayed', 0);

    expect(result.totalCount).toBe(2);
    expect(result.jobs.map((j) => j.name).sort()).toEqual(['djob-0', 'djob-1']);
    expect(result.counts.delayed).toBe(2);
  });

  it('returns failed jobs with attemptsMade >= 1', async () => {
    const seeded = await makeFailed('failedQ', connection, 2);
    try {
      const result = await fetchJobPage(seeded.queue, 'failed', 0);

      expect(result.totalCount).toBe(2);
      expect(result.jobs).toHaveLength(2);
      expect(result.counts.failed).toBe(2);
      for (const job of result.jobs) {
        expect(job.attemptsMade).toBeGreaterThanOrEqual(1);
      }
    } finally {
      await closeSeeded(seeded);
    }
  });

  it('returns completed jobs', async () => {
    const seeded = await makeCompleted('completedQ', connection, 2);
    try {
      const result = await fetchJobPage(seeded.queue, 'completed', 0);

      expect(result.totalCount).toBe(2);
      expect(result.jobs).toHaveLength(2);
      expect(result.counts.completed).toBe(2);
    } finally {
      await closeSeeded(seeded);
    }
  });

  it('returns the active (held) job', async () => {
    held = await holdActive('activeQ', connection);
    extraQueues.push(held.queue);

    const result = await fetchJobPage(held.queue, 'active', 0);

    expect(result.totalCount).toBe(1);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.id).toBe(String(held.job.id));

    // Cleanup (release + worker close) happens in `afterEach`, so it still
    // runs even if one of the assertions above throws.
  });

  it('paginates 25 waiting jobs into 3 pages, newest first, with correct boundary sizes', async () => {
    // Insertion order: job-0 is oldest (first added), job-24 is newest.
    await addWaiting(queue, 25, 'job');

    const page0 = await fetchJobPage(queue, 'waiting', 0);
    expect(page0.totalCount).toBe(25);
    expect(page0.pageCount).toBe(3);
    expect(page0.page).toBe(0);
    expect(page0.jobs).toHaveLength(10);
    // newest first: job-24 down to job-15
    expect(page0.jobs.map((j) => j.name)).toEqual(
      Array.from({ length: 10 }, (_, i) => `job-${24 - i}`),
    );

    const page1 = await fetchJobPage(queue, 'waiting', 1);
    expect(page1.jobs).toHaveLength(10);
    expect(page1.jobs.map((j) => j.name)).toEqual(
      Array.from({ length: 10 }, (_, i) => `job-${14 - i}`),
    );

    const page2 = await fetchJobPage(queue, 'waiting', 2);
    expect(page2.jobs).toHaveLength(5);
    expect(page2.jobs.map((j) => j.name)).toEqual(
      Array.from({ length: 5 }, (_, i) => `job-${4 - i}`),
    );
    expect(page2.page).toBe(2);
  });

  it('clamps a page request beyond the last page to the last page', async () => {
    await addWaiting(queue, 5, 'job');

    const result = await fetchJobPage(queue, 'waiting', 99);

    expect(result.page).toBe(0);
    expect(result.pageCount).toBe(1);
    expect(result.jobs).toHaveLength(5);
  });

  it('reports pageCount 1 and totalCount 0 for an empty status', async () => {
    const result = await fetchJobPage(queue, 'completed', 0);

    expect(result.totalCount).toBe(0);
    expect(result.pageCount).toBe(1);
    expect(result.jobs).toHaveLength(0);
  });

  it('folds a paused queue waiting jobs into the Waiting tab total and job list', async () => {
    await addWaiting(queue, 4, 'pjob');
    await queue.pause();

    const result = await fetchJobPage(queue, 'waiting', 0);

    expect(result.totalCount).toBe(4);
    expect(result.jobs).toHaveLength(4);
    expect(result.jobs.map((j) => j.name).sort()).toEqual(['pjob-0', 'pjob-1', 'pjob-2', 'pjob-3']);
    expect(result.counts.waiting).toBe(4);

    await queue.resume();
  });

  it('reports numeric progress and null progress for non-numeric progress', async () => {
    const [numericJob, objectJob] = await addWaiting(queue, 2, 'progress');
    await numericJob?.updateProgress(42);
    await objectJob?.updateProgress({ percent: 50 });

    const result = await fetchJobPage(queue, 'waiting', 0);
    const byName = new Map(result.jobs.map((j) => [j.name, j]));

    expect(byName.get('progress-0')?.progress).toBe(42);
    expect(byName.get('progress-1')?.progress).toBeNull();
  });
});

describe('getJobDetail', () => {
  it('returns null for a missing job id', async () => {
    await expect(getJobDetail(queue, 'does-not-exist')).resolves.toBeNull();
  });

  it('returns data, opts, stacktrace, and attemptsMade for a failed job', async () => {
    const seeded: SeededWorkerResult = await makeFailed('detailFailedQ', connection, 1);
    try {
      const jobId = String(seeded.jobs[0]?.id);
      const detail = await getJobDetail(seeded.queue, jobId);

      expect(detail).not.toBeNull();
      expect(detail?.data).toEqual({ i: 0 });
      expect(detail?.opts).toBeDefined();
      expect(detail?.stacktrace.length).toBeGreaterThan(0);
      expect(detail?.attemptsMade).toBeGreaterThanOrEqual(1);
    } finally {
      await closeSeeded(seeded);
    }
  });

  it('returns returnvalue for a completed job', async () => {
    const seeded = await makeCompleted('detailCompletedQ', connection, 1, { ok: true });
    try {
      const jobId = String(seeded.jobs[0]?.id);
      const detail = await getJobDetail(seeded.queue, jobId);

      expect(detail).not.toBeNull();
      expect(detail?.returnvalue).toEqual({ ok: true });
      expect(detail?.stacktrace).toEqual([]);
    } finally {
      await closeSeeded(seeded);
    }
  });

  it('preserves rawProgress as the unmapped object while summary progress is null', async () => {
    const [job] = await addWaiting(queue, 1, 'rawprog');
    await job?.updateProgress({ percent: 77 });

    const detail = await getJobDetail(queue, String(job?.id));

    expect(detail?.progress).toBeNull();
    expect(detail?.rawProgress).toEqual({ percent: 77 });
  });

  it('preserves numeric rawProgress alongside the clamped summary progress', async () => {
    const [job] = await addWaiting(queue, 1, 'numprog');
    await job?.updateProgress(150);

    const detail = await getJobDetail(queue, String(job?.id));

    expect(detail?.progress).toBe(100);
    expect(detail?.rawProgress).toBe(150);
  });
});

it('paused fold: invariant check for add-before-pause plus add-while-paused', async () => {
  // Critical mixed case: A jobs before pause, B jobs added while paused.
  // The implementer claims mutually-exclusive buckets, so the fold should see all A+B.
  // This test catches pagination bugs if the fold is wrong (duplicates, omissions, or page boundary breaks).

  const A = 7; // add 7 jobs before pause
  const B = 6; // add 6 jobs while paused, total 13 jobs
  const beforePause = await addWaiting(queue, A, 'before');
  await queue.pause();
  const afterPause = await addWaiting(queue, B, 'after');

  // Fetch all pages and collect every job ID
  const allIds = new Set<string>();
  const allJobs: Array<{ name: string; id: string }> = [];
  const timestamps: number[] = [];

  const firstPage = await fetchJobPage(queue, 'waiting', 0);
  expect(firstPage.totalCount).toBe(A + B);
  expect(firstPage.pageCount).toBe(2); // 13 jobs = 1 full page (10) + 1 partial (3)

  for (let page = 0; page < firstPage.pageCount; page++) {
    const result = await fetchJobPage(queue, 'waiting', page);
    expect(result.totalCount).toBe(A + B); // totalCount must be stable across pages
    for (const job of result.jobs) {
      allJobs.push({ name: job.name, id: job.id });
      allIds.add(job.id);
      timestamps.push(job.timestamp);
    }
  }

  // Invariants:
  // 1. Collected count == totalCount (no page over/under-returns)
  expect(allJobs).toHaveLength(A + B);

  // 2. No duplicate IDs (fold didn't double-list)
  expect(allIds.size).toBe(A + B);

  // 3. Collected set == exactly the enqueued IDs
  const expectedIds = new Set([...beforePause, ...afterPause].map((j) => String(j?.id ?? '')));
  expect(allIds).toEqual(expectedIds);

  // 4. Timestamps monotonically newest-first across the concatenation
  for (let i = 1; i < timestamps.length; i++) {
    expect(timestamps[i]).toBeLessThanOrEqual(timestamps[i - 1]);
  }

  await queue.resume();
});

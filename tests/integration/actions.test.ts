import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionOpts } from '../../src/config.js';
import {
  deleteJob,
  drainQueue,
  pauseQueue,
  promoteJob,
  resumeQueue,
  retryJob,
  togglePauseQueue,
} from '../../src/core/actions.js';
import {
  addDelayed,
  addWaiting,
  closeSeeded,
  type HeldActive,
  holdActive,
  makeCompleted,
  makeFailed,
} from './helpers/seed.js';

const ACTIONS_DB = 3;
const connection: ConnectionOpts = { host: 'localhost', port: 6379, db: ACTIONS_DB };

const WAIT_TIMEOUT_MS = 5000;
const WAIT_INTERVAL_MS = 25;

let redis: Redis;
let queue: Queue;
let extraQueues: Queue[];
let held: HeldActive | undefined;

beforeAll(() => {
  redis = new Redis({ ...connection, maxRetriesPerRequest: null });
});

beforeEach(async () => {
  await redis.flushdb();
  queue = new Queue('actionsQ', { connection });
  extraQueues = [];
  held = undefined;
});

afterEach(async () => {
  // Release *before* closing: `worker.close()` waits for the currently
  // active job to finish, so an unreleased worker would hang here.
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

describe('retryJob', () => {
  it('retries a failed job: moves it back to waiting', async () => {
    const seeded = await makeFailed('retryQ', connection, 1);
    extraQueues.push(seeded.queue);
    const jobId = String(seeded.jobs[0]?.id);

    // Test caveat (Phase 4/5): `makeFailed`'s worker is still running and
    // would instantly re-process a job moved back to `wait`. Close the
    // worker (keep the queue/data) before acting, so the retried job stays
    // put in `waiting` for the assertion below instead of racing back to
    // `failed`.
    await closeSeeded({ worker: seeded.worker });

    const result = await retryJob(seeded.queue, jobId);

    expect(result.ok).toBe(true);
    await vi.waitUntil(
      async () => {
        const counts = await seeded.queue.getJobCounts('waiting', 'failed');
        return (counts.waiting ?? 0) === 1 && (counts.failed ?? 0) === 0;
      },
      { timeout: WAIT_TIMEOUT_MS, interval: WAIT_INTERVAL_MS },
    );
  });

  it('refuses to retry a non-failed (waiting) job', async () => {
    const [job] = await addWaiting(queue, 1, 'wjob');
    const jobId = String(job?.id);

    const result = await retryJob(queue, jobId);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/not failed/i);
    }
    const counts = await queue.getJobCounts('waiting', 'failed');
    expect(counts.waiting).toBe(1);
    expect(counts.failed).toBe(0);
  });

  it('reports not found for a missing job id', async () => {
    const result = await retryJob(queue, 'does-not-exist');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/not found/i);
    }
  });
});

describe('deleteJob', () => {
  it('deletes a waiting job', async () => {
    const [job] = await addWaiting(queue, 1, 'wjob');
    const jobId = String(job?.id);

    const result = await deleteJob(queue, jobId);

    expect(result.ok).toBe(true);
    await expect(queue.getJob(jobId)).resolves.toBeUndefined();
  });

  it('reports not found for a missing job id', async () => {
    const result = await deleteJob(queue, 'does-not-exist');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/not found/i);
    }
  });

  it('refuses to delete a locked active job, without throwing, leaving it in place', async () => {
    held = await holdActive('deleteActiveQ', connection);
    extraQueues.push(held.queue);
    const jobId = String(held.job.id);

    const result = await deleteJob(held.queue, jobId);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/locked/i);
    }
    await expect(held.queue.getJob(jobId)).resolves.toBeDefined();

    // Release + worker close happens in afterEach.
  });
});

describe('promoteJob', () => {
  it('promotes a delayed job to waiting', async () => {
    const [job] = await addDelayed(queue, 1, 60_000, 'djob');
    const jobId = String(job?.id);

    const result = await promoteJob(queue, jobId);

    expect(result.ok).toBe(true);
    const counts = await queue.getJobCounts('waiting', 'delayed');
    expect(counts.waiting).toBe(1);
    expect(counts.delayed).toBe(0);
  });

  it('refuses to promote a non-delayed (waiting) job', async () => {
    const [job] = await addWaiting(queue, 1, 'wjob');
    const jobId = String(job?.id);

    const result = await promoteJob(queue, jobId);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/not delayed/i);
    }
  });

  it('reports not found for a missing job id', async () => {
    const result = await promoteJob(queue, 'does-not-exist');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/not found/i);
    }
  });
});

describe('pauseQueue / resumeQueue / togglePauseQueue', () => {
  it('pauseQueue pauses; resumeQueue resumes', async () => {
    const pauseResult = await pauseQueue(queue);
    expect(pauseResult.ok).toBe(true);
    await expect(queue.isPaused()).resolves.toBe(true);

    const resumeResult = await resumeQueue(queue);
    expect(resumeResult.ok).toBe(true);
    await expect(queue.isPaused()).resolves.toBe(false);
  });

  it('togglePauseQueue pauses a running queue and reports it', async () => {
    const result = await togglePauseQueue(queue);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info).toMatch(/paused/i);
    }
    await expect(queue.isPaused()).resolves.toBe(true);
  });

  it('togglePauseQueue resumes a paused queue and reports it', async () => {
    await queue.pause();

    const result = await togglePauseQueue(queue);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info).toMatch(/resumed/i);
    }
    await expect(queue.isPaused()).resolves.toBe(false);
  });
});

describe('drainQueue', () => {
  it('empties waiting and delayed but leaves active/completed/failed untouched', async () => {
    const queueName = 'drainQ';

    // Order matters (see helper caveats): seed terminal-state jobs and close
    // their workers *first*, while `wait` is still empty, so the
    // subsequently-started `holdActive` worker is guaranteed to grab its own
    // held job rather than something added later. Only then add
    // waiting/delayed jobs, once nothing else can consume them.
    const failedSeed = await makeFailed(queueName, connection, 2);
    await closeSeeded({ worker: failedSeed.worker });
    extraQueues.push(failedSeed.queue);

    const completedSeed = await makeCompleted(queueName, connection, 2);
    await closeSeeded({ worker: completedSeed.worker });
    extraQueues.push(completedSeed.queue);

    held = await holdActive(queueName, connection);
    extraQueues.push(held.queue);

    await addWaiting(held.queue, 3, 'wjob');
    await addDelayed(held.queue, 2, 60_000, 'djob');

    const before = await held.queue.getJobCounts(
      'waiting',
      'delayed',
      'completed',
      'failed',
      'active',
    );
    expect(before.waiting).toBe(3);
    expect(before.delayed).toBe(2);
    expect(before.completed).toBe(2);
    expect(before.failed).toBe(2);
    expect(before.active).toBe(1);

    const result = await drainQueue(held.queue);

    expect(result.ok).toBe(true);
    const after = await held.queue.getJobCounts(
      'waiting',
      'delayed',
      'completed',
      'failed',
      'active',
    );
    expect(after.waiting).toBe(0);
    expect(after.delayed).toBe(0);
    expect(after.completed).toBe(2);
    expect(after.failed).toBe(2);
    expect(after.active).toBe(1);

    // Release + held worker close happens in afterEach.
  });
});

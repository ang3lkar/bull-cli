import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionOpts } from '../../src/config.js';
import { retryFailedJobs } from '../../src/core/actions.js';
import { retryExitCode, runRetry } from '../../src/retryCommand.js';
import { closeSeeded, makeCompleted } from './helpers/seed.js';

const RETRY_DB = 9;
const connection: ConnectionOpts = { host: 'localhost', port: 6379, db: RETRY_DB };
const REDIS_URL = `redis://localhost:6379/${RETRY_DB}`;

let redis: Redis;
let opened: Queue[];

beforeAll(() => {
  redis = new Redis({ ...connection, maxRetriesPerRequest: null });
});

beforeEach(async () => {
  await redis.flushdb();
  opened = [];
});

afterEach(async () => {
  await Promise.all(opened.map((q) => q.close()));
});

afterAll(() => {
  redis.disconnect();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Adds `n` jobs to `name` and lets a worker fail them, then closes that worker
 * so retried jobs stay in `waiting` instead of failing again. Unlike
 * `makeFailed`, it waits for `n` MORE failures than the queue already had, so
 * it can add a second batch to the same queue.
 */
async function failedJobs(name: string, n: number): Promise<{ queue: Queue; ids: string[] }> {
  const queue = new Queue(name, { connection });
  opened.push(queue);
  const before = await queue.getFailedCount();
  const worker = new Worker(
    name,
    async () => {
      throw new Error('seed-induced failure');
    },
    { connection: { ...connection, maxRetriesPerRequest: null } },
  );
  worker.on('error', () => {});
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(String((await queue.add(`job-${i}`, { i })).id));
  }
  await vi.waitUntil(async () => (await queue.getFailedCount()) >= before + n, {
    timeout: 5000,
    interval: 25,
  });
  await worker.close();
  return { queue, ids };
}

async function counts(queue: Queue) {
  const { failed, waiting, completed } = await queue.getJobCounts('failed', 'waiting', 'completed');
  return { failed, waiting, completed };
}

describe('retryFailedJobs against real Redis', () => {
  it('retries every failed job and leaves completed jobs alone', async () => {
    const { queue } = await failedJobs('retryAllQ', 3);
    const done = await makeCompleted('retryAllQ', connection, 2);
    await closeSeeded(done);

    const result = await retryFailedJobs(queue);

    expect(result).toEqual({ matched: 3, retried: 3, errored: 0, errors: [] });
    expect(await counts(queue)).toEqual({ failed: 0, waiting: 3, completed: 2 });
  });

  it('a dry run counts without moving anything', async () => {
    const { queue } = await failedJobs('dryRunQ', 2);

    expect(await retryFailedJobs(queue, { dryRun: true })).toEqual({
      matched: 2,
      retried: 0,
      errored: 0,
      errors: [],
    });
    expect(await retryFailedJobs(queue, { dryRun: true, failedSince: 0 })).toMatchObject({
      matched: 2,
      retried: 0,
    });
    expect(await counts(queue)).toMatchObject({ failed: 2, waiting: 0 });
  });

  it('failedSince only retries jobs that failed at or after the cutoff', async () => {
    const old = await failedJobs('sinceQ', 2);
    await sleep(20);
    const cutoff = Date.now();
    await sleep(20);
    const recent = await failedJobs('sinceQ', 2);

    const result = await retryFailedJobs(recent.queue, { failedSince: cutoff });

    expect(result).toEqual({ matched: 2, retried: 2, errored: 0, errors: [] });
    expect(await counts(recent.queue)).toMatchObject({ failed: 2, waiting: 2 });
    const stillFailed = (await recent.queue.getFailed()).map((job) => job.id).sort();
    expect(stillFailed).toEqual([...old.ids].sort());
  });

  it('jobId retries just that job', async () => {
    const { queue, ids } = await failedJobs('oneQ', 2);

    const result = await retryFailedJobs(queue, { jobId: ids[0] });

    expect(result).toEqual({ matched: 1, retried: 1, errored: 0, errors: [] });
    expect(await queue.getJobState(ids[0])).toBe('waiting');
    expect(await queue.getJobState(ids[1])).toBe('failed');
  });

  it('jobId reports a job that is not failed as an error', async () => {
    const { queue, ids } = await failedJobs('notFailedQ', 1);
    await retryFailedJobs(queue, { jobId: ids[0] });

    const again = await retryFailedJobs(queue, { jobId: ids[0] });

    expect(again.matched).toBe(0);
    expect(again.errored).toBe(0);
    expect(again.errors[0].message).toContain('is waiting, not failed');
  });
});

describe('runRetry (bull-cli retry) against real Redis', () => {
  const deps = { redisUrl: REDIS_URL, prefix: 'bull', now: () => Date.now() };

  it('retries and reports the summary as JSON-ready data with exit code 0', async () => {
    const { queue } = await failedJobs('cliQ', 2);

    const report = await runRetry({ queue: 'cliQ', dryRun: false }, deps);

    expect(report).toEqual({
      queue: 'cliQ',
      dryRun: false,
      filter: {},
      matched: 2,
      retried: 2,
      errored: 0,
      errors: [],
    });
    expect(retryExitCode(report)).toBe(0);
    expect(await counts(queue)).toMatchObject({ failed: 0, waiting: 2 });
  });

  it('honours --since and --dry-run', async () => {
    const { queue } = await failedJobs('cliSinceQ', 2);

    const report = await runRetry({ queue: 'cliSinceQ', dryRun: true, sinceMs: 60_000 }, deps);

    expect(report).toMatchObject({ matched: 2, retried: 0, errored: 0 });
    expect(report.filter.failedSince).toEqual(expect.any(String));
    expect(await counts(queue)).toMatchObject({ failed: 2, waiting: 0 });
  });

  it('exits 1 when a --job-id retry fails', async () => {
    await failedJobs('cliMissingJobQ', 1);

    const report = await runRetry(
      { queue: 'cliMissingJobQ', dryRun: false, jobId: 'does-not-exist' },
      deps,
    );

    expect(report.errors).toEqual([
      { jobId: 'does-not-exist', message: 'Job does-not-exist not found' },
    ]);
    expect(retryExitCode(report)).toBe(1);
  });

  it('reports a queue that does not exist instead of "retrying 0"', async () => {
    const report = await runRetry({ queue: 'nope', dryRun: true }, deps);

    expect(report.errors[0].message).toBe('Queue "nope" not found under prefix "bull"');
    expect(retryExitCode(report)).toBe(1);
  });

  it('fails fast when Redis is unreachable', async () => {
    const started = Date.now();
    const report = await runRetry(
      { queue: 'cliQ', dryRun: true },
      { ...deps, redisUrl: 'redis://127.0.0.1:6399' },
    );

    expect(report.errors[0].message).toContain('Could not connect to Redis');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

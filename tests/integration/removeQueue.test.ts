import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionOpts } from '../../src/config.js';
import { removeQueue } from '../../src/core/actions.js';
import { removeExitCode, runRemove } from '../../src/removeCommand.js';
import {
  addDelayed,
  addWaiting,
  closeSeeded,
  holdActive,
  makeCompleted,
  makeFailed,
} from './helpers/seed.js';

const REMOVE_DB = 10;
const connection: ConnectionOpts = { host: 'localhost', port: 6379, db: REMOVE_DB };
const REDIS_URL = `redis://localhost:6379/${REMOVE_DB}`;

let redis: Redis;

beforeAll(() => {
  redis = new Redis({ ...connection, maxRetriesPerRequest: null });
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(() => {
  redis.disconnect();
});

/** Every key under `bull:<name>:`. `KEYS` is fine here: the DB is flushed and test-only. */
async function keysOf(name: string): Promise<string[]> {
  return redis.keys(`bull:${name}:*`);
}

/**
 * Fills `name` with jobs in every state the dashboard shows (waiting,
 * delayed, completed, failed) plus a job scheduler. Completed and failed come
 * from their own worker runs on the same queue name.
 */
async function seedEverything(name: string): Promise<void> {
  // Close each worker before the next one starts, or the completing worker
  // would also pick up the jobs meant to fail.
  await closeSeeded(await makeCompleted(name, connection, 2));
  await closeSeeded(await makeFailed(name, connection, 2));

  const queue = new Queue(name, { connection });
  try {
    await addWaiting(queue, 3);
    await addDelayed(queue, 2, 60_000);
    await queue.upsertJobScheduler('every-hour', { every: 3_600_000 }, { name: 'tick' });
  } finally {
    await queue.close();
  }
}

describe('removeQueue against real Redis', () => {
  it('removes every key of the queue, including jobs in all states and schedulers', async () => {
    await seedEverything('doomed');
    await seedEverything('survivor');
    expect((await keysOf('doomed')).length).toBeGreaterThan(0);

    const queue = new Queue('doomed', { connection });
    try {
      const result = await removeQueue(queue);
      expect(result).toEqual({ ok: true, info: 'Queue "doomed" removed' });
    } finally {
      await queue.close();
    }

    expect(await keysOf('doomed')).toEqual([]);
    expect(await redis.exists('bull:survivor:meta')).toBe(1);
  });

  it('refuses while a job is active and leaves the queue running', async () => {
    const held = await holdActive('busy', connection);
    try {
      const result = await removeQueue(held.queue);
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.message).toContain('1 active job');
      expect(await held.queue.isPaused()).toBe(false);
      expect(await redis.exists('bull:busy:meta')).toBe(1);
    } finally {
      held.release();
      await closeSeeded(held);
    }
  });

  it('removes a queue with an active job when forced', async () => {
    const held = await holdActive('forced', connection);
    try {
      const result = await removeQueue(held.queue, { force: true });
      expect(result.ok).toBe(true);
      expect(await redis.exists('bull:forced:meta')).toBe(0);
    } finally {
      held.release();
      await closeSeeded(held);
    }
  });
});

describe('runRemove against real Redis', () => {
  const deps = { redisUrl: REDIS_URL, prefix: 'bull' };

  it('a dry run reports the counts and changes nothing', async () => {
    await seedEverything('preview');
    const before = (await keysOf('preview')).sort();

    const report = await runRemove({ queue: 'preview', dryRun: true, force: false }, deps);

    // The scheduler's first job lands in waiting or delayed depending on
    // timing, so only their sum is fixed.
    expect(report).toMatchObject({
      queue: 'preview',
      dryRun: true,
      force: false,
      counts: { active: 0, completed: 2, failed: 2 },
      total: 10,
      removed: false,
      error: null,
    });
    expect((report.counts?.waiting ?? 0) + (report.counts?.delayed ?? 0)).toBe(6);
    expect(removeExitCode(report)).toBe(0);
    expect((await keysOf('preview')).sort()).toEqual(before);
  });

  it('--yes removes the queue', async () => {
    await seedEverything('gone');
    const report = await runRemove({ queue: 'gone', dryRun: false, force: false }, deps);
    expect(report.removed).toBe(true);
    expect(report.error).toBeNull();
    expect(removeExitCode(report)).toBe(0);
    expect(await keysOf('gone')).toEqual([]);
  });

  it('a missing queue is an error and is not created', async () => {
    const report = await runRemove({ queue: 'typo', dryRun: true, force: false }, deps);
    expect(report.error).toBe('Queue "typo" not found under prefix "bull"');
    expect(removeExitCode(report)).toBe(1);
    expect(await keysOf('typo')).toEqual([]);
  });

  it('reports the active-job refusal and exits 1', async () => {
    const held = await holdActive('cli-busy', connection);
    try {
      const report = await runRemove({ queue: 'cli-busy', dryRun: false, force: false }, deps);
      expect(report.removed).toBe(false);
      expect(report.error).toContain('1 active job');
      expect(report.counts?.active).toBe(1);
      expect(removeExitCode(report)).toBe(1);
      expect(await redis.exists('bull:cli-busy:meta')).toBe(1);
    } finally {
      held.release();
      await closeSeeded(held);
    }
  });
});

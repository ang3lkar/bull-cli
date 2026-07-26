import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionOpts } from '../../src/config.js';
import { dumpQueuesJson } from '../../src/jsonOutput.js';

const JSON_OUTPUT_DB = 6;
const connection: ConnectionOpts = { host: 'localhost', port: 6379, db: JSON_OUTPUT_DB };
const redisUrl = `redis://localhost:6379/${JSON_OUTPUT_DB}`;
const prefix = 'bull';

let redis: Redis;
let queues: Queue[];

async function createQueue(name: string): Promise<Queue> {
  const queue = new Queue(name, { connection, prefix });
  await queue.waitUntilReady();
  await vi.waitUntil(async () => (await redis.exists(`${prefix}:${name}:meta`)) === 1);
  queues.push(queue);
  return queue;
}

beforeAll(() => {
  redis = new Redis({ ...connection, maxRetriesPerRequest: null });
});

beforeEach(async () => {
  queues = [];
  await redis.flushdb();
});

afterEach(async () => {
  await Promise.all(queues.map((queue) => queue.close()));
});

afterAll(() => {
  redis.disconnect();
});

describe('dumpQueuesJson', () => {
  it('returns all discovered queues with counts', async () => {
    const alpha = await createQueue('alpha');
    const beta = await createQueue('beta');

    await alpha.add('alpha-1', { i: 1 });
    await alpha.add('alpha-2', { i: 2 });
    await alpha.add('alpha-delayed', { i: 3 }, { delay: 60_000 });

    await beta.add('beta-1', { i: 1 });
    await beta.pause();

    await expect(dumpQueuesJson({ redisUrl, prefix })).resolves.toEqual({
      queues: [
        {
          name: 'alpha',
          isPaused: false,
          counts: { active: 0, waiting: 2, completed: 0, failed: 0, delayed: 1 },
        },
        {
          name: 'beta',
          isPaused: true,
          counts: { active: 0, waiting: 1, completed: 0, failed: 0, delayed: 0 },
        },
      ],
    });
  });

  it('returns only the selected queue with --queue style filtering', async () => {
    const alpha = await createQueue('alpha');
    await createQueue('beta');

    await alpha.add('alpha-1', { i: 1 });

    await expect(dumpQueuesJson({ redisUrl, prefix, queueName: 'alpha' })).resolves.toEqual({
      queues: [
        {
          name: 'alpha',
          isPaused: false,
          counts: { active: 0, waiting: 1, completed: 0, failed: 0, delayed: 0 },
        },
      ],
    });
  });

  it('throws when the selected queue does not exist', async () => {
    await createQueue('alpha');

    await expect(dumpQueuesJson({ redisUrl, prefix, queueName: 'missing' })).rejects.toThrow(
      'Queue "missing" not found',
    );
  });

  it('skips discovered queues that bullmq cannot open by name', async () => {
    const alpha = await createQueue('alpha');
    await alpha.add('alpha-1', { i: 1 });

    // Simulates a queue key written by another client/older bullmq version.
    await redis.hset(`${prefix}:bad:name:meta`, 'paused', '1');

    await expect(dumpQueuesJson({ redisUrl, prefix })).resolves.toEqual({
      queues: [
        {
          name: 'alpha',
          isPaused: false,
          counts: { active: 0, waiting: 1, completed: 0, failed: 0, delayed: 0 },
        },
      ],
    });
  });
});

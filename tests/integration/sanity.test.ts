import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const SANITY_DB = 15;
const connection = { host: 'localhost', port: 6379, db: SANITY_DB };

let redis: Redis;
let queue: Queue;

beforeAll(() => {
  redis = new Redis({ ...connection, maxRetriesPerRequest: null });
  queue = new Queue('sanity', { connection });
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await queue.close();
  redis.disconnect();
});

describe('redis + bullmq sanity', () => {
  it('pings redis', async () => {
    await expect(redis.ping()).resolves.toBe('PONG');
  });

  it('adds a job and reports it as waiting', async () => {
    await queue.add('sanity-job', { foo: 'bar' });
    const counts = await queue.getJobCounts('waiting');
    expect(counts.waiting).toBe(1);
  });
});

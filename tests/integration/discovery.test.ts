import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverQueues } from '../../src/core/discovery.js';

const DISCOVERY_DB = 1;
const connection = { host: 'localhost', port: 6379, db: DISCOVERY_DB };

let redis: Redis;
let queues: Queue[];

/**
 * Creates a bullmq Queue and waits for its `bull:<name>:meta` hash to exist.
 * bullmq's `Queue` constructor writes the meta hash *fire-and-forget* off its
 * own internal `waitUntilReady()` call — it's not tied to the promise our
 * `await queue.waitUntilReady()` resolves, so awaiting that alone is racy
 * (confirmed empirically: it intermittently misses the meta key). We poll
 * for the key directly so discovery-seeding is deterministic.
 */
async function seedQueue(name: string): Promise<Queue> {
  const queue = new Queue(name, { connection });
  await queue.waitUntilReady();
  await vi.waitUntil(async () => (await redis.exists(`bull:${name}:meta`)) === 1);
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

describe('discoverQueues', () => {
  it('returns an empty array when there are no bullmq queues', async () => {
    await expect(discoverQueues(redis)).resolves.toEqual([]);
  });

  it('discovers queues created via bullmq', async () => {
    await seedQueue('emailQ');
    await seedQueue('smsQ');

    const result = await discoverQueues(redis);

    expect(result).toEqual([
      { name: 'emailQ', isPaused: false },
      { name: 'smsQ', isPaused: false },
    ]);
  });

  it('resolves a colon-containing queue name intact', async () => {
    // bullmq's own `Queue` constructor rejects names containing `:`, so a
    // colon-containing queue can only exist in the keyspace via another
    // producer/library or an older bullmq version. Discovery only cares
    // about the raw Redis key shape, so we seed the meta key directly to
    // exercise that case.
    await redis.hset('bull:billing:invoices:meta', 'opts.maxLenEvents', '10000');

    const result = await discoverQueues(redis);

    expect(result).toEqual([{ name: 'billing:invoices', isPaused: false }]);
  });

  it('reflects paused state, then resumed state', async () => {
    const queue = await seedQueue('smsQ');

    await queue.pause();
    const pausedResult = await discoverQueues(redis);
    expect(pausedResult).toEqual([{ name: 'smsQ', isPaused: true }]);

    await queue.resume();
    const resumedResult = await discoverQueues(redis);
    expect(resumedResult).toEqual([{ name: 'smsQ', isPaused: false }]);
  });

  it('ignores non-bull keys and keys that only superficially match', async () => {
    await seedQueue('emailQ');

    await redis.set('user:1', 'someone');
    await redis.set('bullish:x:meta', 'not a queue');
    await redis.hset('bull:foo:events', 'field', 'value');

    const result = await discoverQueues(redis);

    expect(result).toEqual([{ name: 'emailQ', isPaused: false }]);
  });

  it('discovers all queues exactly once across a multi-iteration SCAN (dedup)', async () => {
    const names = Array.from({ length: 30 }, (_, i) => `queue${String(i).padStart(2, '0')}`);
    await Promise.all(names.map((name) => seedQueue(name)));

    // Pad the keyspace with unrelated keys so a COUNT-100 SCAN needs several
    // cursor round trips to traverse the full dictionary, exercising both the
    // cursor loop and de-duplication of keys revisited across iterations.
    const noisePipeline = redis.pipeline();
    for (let i = 0; i < 2000; i++) {
      noisePipeline.set(`noise:${i}`, '1');
    }
    await noisePipeline.exec();

    const result = await discoverQueues(redis);

    expect(result.map((q) => q.name)).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(result).toHaveLength(30);
  });

  it('returns queues sorted alphabetically', async () => {
    await seedQueue('reportQ');
    await seedQueue('emailQ');
    await seedQueue('smsQ');

    const result = await discoverQueues(redis);

    expect(result.map((q) => q.name)).toEqual(['emailQ', 'reportQ', 'smsQ']);
  });
});

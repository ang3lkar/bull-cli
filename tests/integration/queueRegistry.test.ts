import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionOpts } from '../../src/config.js';
import { createQueueRegistry, type QueueRegistry } from '../../src/core/queueRegistry.js';

const REGISTRY_DB = 13;
const connection: ConnectionOpts = { host: 'localhost', port: 6379, db: REGISTRY_DB };

let redis: Redis;
let registry: QueueRegistry;

beforeAll(() => {
  redis = new Redis({ ...connection, maxRetriesPerRequest: null });
});

beforeEach(async () => {
  await redis.flushdb();
  registry = createQueueRegistry(connection, 'bull');
});

afterEach(async () => {
  await registry.closeAll();
});

afterAll(() => {
  redis.disconnect();
});

describe('createQueueRegistry', () => {
  it('getQueue returns the same cached instance on repeated calls', () => {
    const first = registry.getQueue('emailQ');
    const second = registry.getQueue('emailQ');

    expect(second).toBe(first);
  });

  it('getQueue returns distinct instances for distinct names', () => {
    const email = registry.getQueue('emailQ');
    const sms = registry.getQueue('smsQ');

    expect(email).not.toBe(sms);
  });

  it('a queue obtained via getQueue is usable against real redis', async () => {
    const queue = registry.getQueue('emailQ');

    await queue.add('hello', {});
    const counts = await queue.getJobCounts('waiting');

    expect(counts.waiting).toBe(1);
  });

  it('sync evicts and closes a queue that disappeared, and a subsequent getQueue returns a fresh working instance', async () => {
    const first = registry.getQueue('emailQ');
    await first.waitUntilReady();
    await first.add('hello', {});

    await registry.sync([]);

    const second = registry.getQueue('emailQ');
    expect(second).not.toBe(first);

    // The fresh instance must still work against redis (proves the evicted
    // queue's connection close didn't tear down anything shared).
    await second.add('world', {});
    const counts = await second.getJobCounts('waiting');
    expect(counts.waiting).toBe(2);
  });

  it('sync keeps queues that are still present', async () => {
    const email = registry.getQueue('emailQ');

    await registry.sync(['emailQ']);

    expect(registry.getQueue('emailQ')).toBe(email);
  });

  it('closeAll closes every cached queue and leaves no hanging handles', async () => {
    registry.getQueue('emailQ');
    registry.getQueue('smsQ');

    await expect(registry.closeAll()).resolves.toBeUndefined();

    // Cleanly resolving (and this file exiting without vitest hanging) is
    // the actual assertion here.
    await expect(registry.closeAll()).resolves.toBeUndefined();
  });

  it('a registry created with a custom prefix writes queue keys under that prefix', async () => {
    const customRegistry = createQueueRegistry(connection, 'myapp');
    try {
      const queue = customRegistry.getQueue('emailQ');
      await queue.add('hello', {});

      // bullmq writes the meta hash fire-and-forget, off its own internal
      // `waitUntilReady()` call — not tied to `queue.add()`'s resolution —
      // so poll for it rather than checking immediately (see
      // `discovery.test.ts`'s `seedQueue` for the same caveat).
      await vi.waitUntil(async () => (await redis.exists('myapp:emailQ:meta')) === 1);

      expect(await redis.exists('bull:emailQ:meta')).toBe(0);
    } finally {
      await customRegistry.closeAll();
    }
  });
});

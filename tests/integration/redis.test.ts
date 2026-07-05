import type { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { createRedisClient } from '../../src/core/redis.js';
import type { ConnectionStatus } from '../../src/core/types.js';

const TEST_DB = 14;
const REACHABLE_URL = `redis://localhost:6379/${TEST_DB}`;
const UNREACHABLE_URL = 'redis://localhost:9999';

const clients: Redis[] = [];

function trackedClient(url: string, onStatus?: (status: ConnectionStatus) => void): Redis {
  const client = createRedisClient(url, onStatus);
  clients.push(client);
  return client;
}

afterAll(() => {
  for (const client of clients) {
    client.disconnect();
  }
});

describe('createRedisClient', () => {
  it('reaches ready status against reachable redis and responds to PING', async () => {
    const statuses: ConnectionStatus[] = [];
    const client = trackedClient(REACHABLE_URL, (status) => statuses.push(status));

    await client.connect();
    await expect(client.ping()).resolves.toBe('PONG');

    expect(statuses.some((s) => s.state === 'ready')).toBe(true);
  });

  it('reports a typed error status for an unreachable redis without throwing', async () => {
    const statuses: ConnectionStatus[] = [];
    const client = trackedClient(UNREACHABLE_URL, (status) => statuses.push(status));

    await expect(client.connect()).rejects.toBeInstanceOf(Error);

    await expect
      .poll(() => statuses.some((s) => s.state === 'error'), { timeout: 5000 })
      .toBe(true);

    const errorStatus = statuses.find((s) => s.state === 'error');
    expect(errorStatus).toMatchObject({
      state: 'error',
      url: UNREACHABLE_URL,
    });
    if (errorStatus?.state === 'error') {
      expect(typeof errorStatus.message).toBe('string');
      expect(errorStatus.message.length).toBeGreaterThan(0);
    }
  });
});

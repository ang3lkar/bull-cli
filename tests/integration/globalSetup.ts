import { Redis } from 'ioredis';

const REDIS_URL = 'redis://localhost:6379';
const PING_TIMEOUT_MS = 2000;

export async function setup(): Promise<void> {
  const client = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: PING_TIMEOUT_MS,
  });

  let timeoutId: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      client.connect().then(() => client.ping()),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('timed out')), PING_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    throw new Error('Redis not reachable — run `npm run redis:up`', { cause: error });
  } finally {
    clearTimeout(timeoutId);
    client.disconnect();
  }
}

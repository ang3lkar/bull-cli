import type { Redis } from 'ioredis';
import type { QueueInfo } from './types.js';

/** BullMQ writes one `bull:<queue>:meta` hash per queue; never use `KEYS` in production code. */
const META_KEY_PATTERN = 'bull:*:meta';
const META_PREFIX = 'bull:';
const META_SUFFIX = ':meta';
const SCAN_COUNT = 100;

/**
 * Derives a queue name from a `bull:<name>:meta` key by stripping exactly the
 * leading `bull:` and trailing `:meta`, so names containing colons (e.g.
 * `billing:invoices`) survive intact. Returns `null` for keys that don't
 * match the expected shape or that resolve to an empty/degenerate name
 * (e.g. `bull::meta`, or a key too short to hold both affixes distinctly).
 */
export function queueNameFromMetaKey(key: string): string | null {
  if (!key.startsWith(META_PREFIX) || !key.endsWith(META_SUFFIX)) {
    return null;
  }
  if (key.length < META_PREFIX.length + META_SUFFIX.length) {
    return null;
  }

  const name = key.slice(META_PREFIX.length, -META_SUFFIX.length);
  return name.length > 0 ? name : null;
}

/**
 * Discovers BullMQ queues by scanning for `bull:*:meta` keys (cursor-based
 * `SCAN`, never `KEYS`, so this stays safe against large keyspaces). Paused
 * state is read via a single pipelined batch of `HEXISTS <meta> paused`
 * calls — no `bullmq` `Queue` instances are created here. Results are
 * deduplicated (SCAN can revisit keys across cursor iterations) and sorted
 * alphabetically by name.
 */
export async function discoverQueues(redis: Redis): Promise<QueueInfo[]> {
  const metaKeys = new Set<string>();
  let cursor = '0';

  do {
    const [nextCursor, batch] = await redis.scan(
      cursor,
      'MATCH',
      META_KEY_PATTERN,
      'COUNT',
      SCAN_COUNT,
    );
    cursor = nextCursor;
    for (const key of batch) {
      metaKeys.add(key);
    }
  } while (cursor !== '0');

  const entries: Array<{ key: string; name: string }> = [];
  for (const key of metaKeys) {
    const name = queueNameFromMetaKey(key);
    if (name !== null) {
      entries.push({ key, name });
    }
  }

  if (entries.length === 0) {
    return [];
  }

  const pipeline = redis.pipeline();
  for (const entry of entries) {
    pipeline.hexists(entry.key, 'paused');
  }
  const results = await pipeline.exec();

  const queues: QueueInfo[] = entries.map((entry, index) => {
    const result = results?.[index];
    const [error, reply] = result ?? [null, 0];
    const isPaused = error == null && reply === 1;
    return { name: entry.name, isPaused };
  });

  queues.sort((a, b) => a.name.localeCompare(b.name));
  return queues;
}

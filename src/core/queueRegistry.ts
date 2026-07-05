import { Queue } from 'bullmq';
import type { ConnectionOpts } from '../config.js';

/**
 * Lazy cache of `bullmq` `Queue` instances, keyed by queue name. Discovery
 * only tells us queue *names*; a `Queue` instance is only created the first
 * time something (job fetching, actions) actually needs to talk to it.
 */
export interface QueueRegistry {
  /**
   * Returns the cached `Queue` for `name`, creating and caching it if
   * needed. `new Queue(name, ...)` throws SYNCHRONOUSLY for a name bullmq
   * itself would never produce — most notably one containing `:` (bullmq
   * 5.x rejects it outright), which `discovery.ts` can nonetheless report
   * (an older bullmq version or another client can write such a key). This
   * function does NOT catch that throw — callers that might pass an
   * un-instantiable name (the store's per-queue fetch, via the wiring
   * layer's `safeFetch`/`safeAction` guards in `wiring.ts`) are responsible
   * for normalizing it into whatever shape they need.
   */
  getQueue(name: string): Queue;
  /**
   * Reconciles the cache against the currently discovered queue names,
   * closing and evicting any cached queue that's no longer present (the
   * "queue disappeared mid-session" path). Queues in `names` that aren't
   * cached yet are left alone — they're created lazily on first `getQueue`.
   *
   * Audited safe against un-instantiable names (see `getQueue`'s doc
   * comment above): `sync` never calls `getQueue` on an incoming name, it
   * only iterates *already-cached* instances, so a name it can't open
   * simply passes through the `keep` set untouched rather than being
   * (re)instantiated. `closeAll` needs no such guard either, for the same
   * reason — it only closes what's already cached.
   */
  sync(names: string[]): Promise<void>;
  /** Closes and evicts every cached queue. */
  closeAll(): Promise<void>;
}

export function createQueueRegistry(connection: ConnectionOpts): QueueRegistry {
  const queues = new Map<string, Queue>();

  function getQueue(name: string): Queue {
    const existing = queues.get(name);
    if (existing) {
      return existing;
    }
    const queue = new Queue(name, { connection });
    queues.set(name, queue);
    return queue;
  }

  async function sync(names: string[]): Promise<void> {
    const keep = new Set(names);
    const stale: Queue[] = [];
    for (const [name, queue] of queues) {
      if (!keep.has(name)) {
        stale.push(queue);
        queues.delete(name);
      }
    }
    await Promise.all(stale.map((queue) => queue.close()));
  }

  async function closeAll(): Promise<void> {
    const all = [...queues.values()];
    queues.clear();
    await Promise.all(all.map((queue) => queue.close()));
  }

  return { getQueue, sync, closeAll };
}

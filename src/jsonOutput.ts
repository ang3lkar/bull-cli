import type { Queue } from 'bullmq';
import { connectionFromUrl } from './config.js';
import { discoverQueues } from './core/discovery.js';
import { fetchQueueCounts } from './core/jobs.js';
import { createQueueRegistry, type QueueRegistry } from './core/queueRegistry.js';
import { createRedisClient } from './core/redis.js';
import type { JobStatus, QueueInfo } from './core/types.js';

export interface QueueJson {
  name: string;
  isPaused: boolean;
  counts: Record<JobStatus, number>;
}

export interface QueuesJson {
  queues: QueueJson[];
}

export interface DumpQueuesJsonInput {
  redisUrl: string;
  prefix: string;
  queueName?: string;
}

type QueueCountsMap = Record<string, Record<JobStatus, number>>;
const INVALID_QUEUE_NAME_ERROR = 'Queue name cannot contain :';

async function safeFetch<T>(
  registry: QueueRegistry,
  queueName: string,
  run: (queue: Queue) => Promise<T>,
): Promise<T> {
  const queue = registry.getQueue(queueName);
  return run(queue);
}

function filterQueues(queues: QueueInfo[], queueName?: string): QueueInfo[] {
  if (queueName === undefined) {
    return queues;
  }

  const queue = queues.find((entry) => entry.name === queueName);
  if (!queue) {
    throw new Error(`Queue "${queueName}" not found`);
  }

  return [queue];
}

function shouldSkipQueue(error: unknown): boolean {
  return error instanceof Error && error.message.includes(INVALID_QUEUE_NAME_ERROR);
}

export function buildQueuesJson(
  discoveredQueues: QueueInfo[],
  countsByQueue: QueueCountsMap,
  queueName?: string,
): QueuesJson {
  const selectedQueues = filterQueues(discoveredQueues, queueName);
  return {
    queues: selectedQueues.map((queue) => ({
      name: queue.name,
      isPaused: queue.isPaused,
      counts: countsByQueue[queue.name],
    })),
  };
}

export async function dumpQueuesJson(input: DumpQueuesJsonInput): Promise<QueuesJson> {
  const { redisUrl, prefix, queueName } = input;
  const registry = createQueueRegistry(connectionFromUrl(redisUrl), prefix);
  const redis = createRedisClient(redisUrl);

  try {
    await redis.connect();
    const discoveredQueues = await discoverQueues(redis, prefix);
    const selectedQueues = filterQueues(discoveredQueues, queueName);
    const queueCountEntries = await Promise.all(
      selectedQueues.map(async (queue) => {
        try {
          const counts = await safeFetch(registry, queue.name, (entry) => fetchQueueCounts(entry));
          return { queue, counts };
        } catch (error) {
          if (shouldSkipQueue(error)) {
            return null;
          }
          throw error;
        }
      }),
    );
    const successfulEntries = queueCountEntries.filter((entry) => entry !== null);
    const countsByQueue = Object.fromEntries(
      successfulEntries.map((entry) => [entry.queue.name, entry.counts]),
    );
    const outputQueues = successfulEntries.map((entry) => entry.queue);

    return buildQueuesJson(outputQueues, countsByQueue);
  } finally {
    await registry.closeAll();
    redis.disconnect();
  }
}

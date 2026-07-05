import { type Job, Queue, Worker } from 'bullmq';
import { vi } from 'vitest';
import type { ConnectionOpts } from '../../../src/config.js';

const WAIT_TIMEOUT_MS = 5000;
const WAIT_INTERVAL_MS = 25;

function workerConnection(connection: ConnectionOpts): ConnectionOpts {
  // bullmq Workers use blocking Redis commands and refuse to start unless
  // maxRetriesPerRequest is explicitly disabled.
  return { ...connection, maxRetriesPerRequest: null } as ConnectionOpts;
}

/**
 * Adds `n` waiting jobs named `<namePrefix>-0` .. `<namePrefix>-{n-1}`, in
 * insertion order (index 0 = oldest/first added, index n-1 = newest).
 */
export async function addWaiting(queue: Queue, n: number, namePrefix = 'job'): Promise<Job[]> {
  const jobs: Job[] = [];
  for (let i = 0; i < n; i++) {
    jobs.push(await queue.add(`${namePrefix}-${i}`, { i }));
  }
  return jobs;
}

/**
 * Adds `n` delayed jobs (all delayed by `delayMs`), in insertion order (index
 * 0 = oldest/first added).
 */
export async function addDelayed(
  queue: Queue,
  n: number,
  delayMs: number,
  namePrefix = 'job',
): Promise<Job[]> {
  const jobs: Job[] = [];
  for (let i = 0; i < n; i++) {
    jobs.push(await queue.add(`${namePrefix}-${i}`, { i }, { delay: delayMs }));
  }
  return jobs;
}

/** A dedicated Queue+Worker pair created by a seeding helper, for cleanup. */
export interface SeededWorkerResult {
  queue: Queue;
  worker: Worker<unknown, unknown, string>;
  jobs: Job[];
}

/**
 * Creates `n` jobs on a dedicated queue plus a Worker whose processor always
 * throws, then polls `getJobCounts` until all `n` are reported failed
 * (bullmq's meta/state writes are fire-and-forget, so this can't be awaited
 * directly off `queue.add`/`worker.run`).
 */
export async function makeFailed(
  queueName: string,
  connection: ConnectionOpts,
  n: number,
): Promise<SeededWorkerResult> {
  const queue = new Queue(queueName, { connection });
  const worker = new Worker<unknown, unknown, string>(
    queueName,
    async () => {
      throw new Error('seed-induced failure');
    },
    { connection: workerConnection(connection) },
  );
  worker.on('error', () => {});

  const jobs: Job[] = [];
  for (let i = 0; i < n; i++) {
    jobs.push(await queue.add(`job-${i}`, { i }));
  }

  await vi.waitUntil(
    async () => {
      const counts = await queue.getJobCounts('failed');
      return (counts.failed ?? 0) >= n;
    },
    { timeout: WAIT_TIMEOUT_MS, interval: WAIT_INTERVAL_MS },
  );

  return { queue, worker, jobs };
}

/**
 * Creates `n` jobs on a dedicated queue plus a Worker whose processor
 * resolves with `returnvalue`, then polls until all `n` are reported
 * completed.
 */
export async function makeCompleted(
  queueName: string,
  connection: ConnectionOpts,
  n: number,
  returnvalue?: unknown,
): Promise<SeededWorkerResult> {
  const queue = new Queue(queueName, { connection });
  const worker = new Worker<unknown, unknown, string>(queueName, async () => returnvalue, {
    connection: workerConnection(connection),
  });
  worker.on('error', () => {});

  const jobs: Job[] = [];
  for (let i = 0; i < n; i++) {
    jobs.push(await queue.add(`job-${i}`, { i }));
  }

  await vi.waitUntil(
    async () => {
      const counts = await queue.getJobCounts('completed');
      return (counts.completed ?? 0) >= n;
    },
    { timeout: WAIT_TIMEOUT_MS, interval: WAIT_INTERVAL_MS },
  );

  return { queue, worker, jobs };
}

/** A single job held in the `active` state until `release()` is called. */
export interface HeldActive {
  queue: Queue;
  worker: Worker<unknown, unknown, string>;
  job: Job;
  /** Lets the blocked processor resolve, allowing the job to complete. */
  release: () => void;
}

/**
 * Creates a single job on a dedicated queue plus a Worker whose processor
 * blocks on an internal promise, then polls until the job is reported
 * active. Call `release()` (typically in test cleanup) to unblock the
 * processor so the Worker can close without hanging.
 */
export async function holdActive(
  queueName: string,
  connection: ConnectionOpts,
): Promise<HeldActive> {
  const queue = new Queue(queueName, { connection });

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const worker = new Worker<unknown, unknown, string>(
    queueName,
    async () => {
      await gate;
    },
    { connection: workerConnection(connection) },
  );
  worker.on('error', () => {});

  const job = await queue.add('held-job', {});

  await vi.waitUntil(
    async () => {
      const counts = await queue.getJobCounts('active');
      return (counts.active ?? 0) >= 1;
    },
    { timeout: WAIT_TIMEOUT_MS, interval: WAIT_INTERVAL_MS },
  );

  return { queue, worker, job, release };
}

/** Closes every Queue/Worker referenced by the given seeding results. */
export async function closeSeeded(
  ...results: Array<{ queue?: Queue; worker?: Worker<unknown, unknown, string> } | undefined>
): Promise<void> {
  const handles: Array<Queue | Worker<unknown, unknown, string>> = [];
  for (const result of results) {
    if (result?.queue) handles.push(result.queue);
    if (result?.worker) handles.push(result.worker);
  }
  await Promise.all(handles.map((handle) => handle.close()));
}

#!/usr/bin/env node
/**
 * Dev utility: populates a local Redis with demo BullMQ queues/jobs so
 * `npm run dev` (or the built `bull-cli`) has something to look at.
 *
 * Targets `redis://localhost:6379/0` by default — the *default* logical DB,
 * which the test suites never touch (integration/e2e use dedicated DBs
 * separate from db 0; unit tests use fakes). Resolution follows the same
 * precedence as the CLI itself: an optional positional URL argument >
 * `REDIS_URL` env var > `redis://localhost:6379` (see `resolveRedisUrl` in
 * `src/config.ts`).
 *
 * Usage:
 *   npm run seed                          # seed redis://localhost:6379 (or $REDIS_URL)
 *   npm run seed -- redis://host:6379/0   # seed an explicit URL
 *   npm run seed -- --hold                # also hold one job "active" for ~60s
 *   npm run seed -- --force               # allow seeding a non-localhost host (see below)
 *
 * Idempotent-ish: each queue is `obliterate({ force: true })`d before being
 * re-seeded, so repeated runs don't accumulate jobs. This is destructive by
 * name — obliterating `emailQ`/`smsQ`/`reportQ`/`progressQ` (and `activeQ`
 * under `--hold`) wipes out ANY existing queue with that name, real or demo.
 * To guard against pointing this at a shared/staging Redis by accident, the
 * script refuses to run against a non-localhost host unless `--force` is
 * passed — and that check runs before any Redis connection is attempted.
 *
 * Note: BullMQ *queue names themselves* must not contain colons — bullmq
 * 5.x rejects them outright (`new Queue('billing:invoices', ...)` throws
 * synchronously, "Queue name cannot contain :") — so the demo queues
 * created here via `trackQueue` use plain names (`emailQ`, `smsQ`,
 * `reportQ`, ...). A colon-containing name can still exist in Redis via an
 * older bullmq version or another client, though, and `discovery.ts`
 * correctly reports it (see `tests/integration/discovery.test.ts`'s
 * equivalent case) even though it can never be *opened*. `seedBillingInvoices`
 * demonstrates exactly that shape via a raw `HSET` (bypassing bullmq's
 * `Queue` constructor entirely, the only way such a key can be produced) —
 * safe to seed now that `DashboardStore`/`wiring.ts` isolate a per-queue
 * open/fetch failure (toast + empty job list) instead of treating it as a
 * fatal whole-session connection error.
 */
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { type ConnectionOpts, connectionFromUrl, resolveRedisUrl } from '../src/config.js';

const POLL_INTERVAL_MS = 50;
const POLL_TIMEOUT_MS = 15000;
const HOLD_DURATION_MS = 60000;
const DELAYED_MS = 5 * 60 * 1000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const args = process.argv.slice(2);
const hold = args.includes('--hold');
const forceNonLocal = args.includes('--force');
const positionalUrl = args.find((arg) => !arg.startsWith('--'));

const redisUrl = resolveRedisUrl(positionalUrl, process.env);
const connection = connectionFromUrl(redisUrl);

const targetQueueNames = ['emailQ', 'smsQ', 'reportQ', 'progressQ', ...(hold ? ['activeQ'] : [])];

// Safety gate: refuse to run against anything but localhost unless the
// caller explicitly opts in. Runs before any Redis connection is attempted
// (it only inspects the already-parsed `connection.host`), so a typo'd or
// intentionally-remote URL can't cause any damage before this check fires.
if (!LOCAL_HOSTS.has(connection.host) && !forceNonLocal) {
  console.error(`Refusing to seed "${redisUrl}" (host "${connection.host}" is not localhost).`);
  console.error(
    `This script obliterates and re-seeds the following queues by name: ${targetQueueNames.join(', ')}.`,
  );
  console.error(
    'Running it against a shared/staging Redis could silently destroy real queues with those names.',
  );
  console.error('Pass --force if you are sure this is safe.');
  process.exit(1);
}

// bullmq Workers use blocking Redis commands and refuse to start unless
// maxRetriesPerRequest is explicitly disabled (same requirement as the
// integration test seeding helpers).
const workerConnection = { ...connection, maxRetriesPerRequest: null } as ConnectionOpts;

const openQueues: Queue[] = [];
const openWorkers: Array<Worker<unknown, unknown, string>> = [];
/** Raw client for the `billing:invoices` meta-key demo (see `seedBillingInvoices`) — not a bullmq `Queue`, disconnected (not `.close()`d) in the `finally` block below. */
let rawRedis: Redis | undefined;

function trackQueue(name: string): Queue {
  const queue = new Queue(name, { connection });
  openQueues.push(queue);
  return queue;
}

function untrackWorker(worker: Worker<unknown, unknown, string>): void {
  const index = openWorkers.indexOf(worker);
  if (index !== -1) {
    openWorkers.splice(index, 1);
  }
}

async function waitUntil(check: () => Promise<boolean>, label: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() - start > POLL_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function seedWaiting(queue: Queue, n: number, namePrefix: string): Promise<void> {
  for (let i = 0; i < n; i++) {
    await queue.add(`${namePrefix}-${i}`, { i });
  }
}

async function seedDelayed(
  queue: Queue,
  n: number,
  delayMs: number,
  namePrefix: string,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    await queue.add(`${namePrefix}-${i}`, { i }, { delay: delayMs });
  }
}

/**
 * Adds `n` jobs and processes them to completion with a real, short-lived
 * Worker, then closes that worker before returning. Closing it matters: a
 * still-running resolving Worker would otherwise immediately re-process any
 * `waiting` jobs added to the same queue afterwards (the same caveat the
 * Phase 4/9 integration seeding helpers document).
 */
async function seedCompleted(
  queue: Queue,
  queueName: string,
  n: number,
  returnvalue: unknown,
): Promise<void> {
  const worker = new Worker<unknown, unknown, string>(queueName, async () => returnvalue, {
    connection: workerConnection,
  });
  worker.on('error', () => {});
  openWorkers.push(worker);

  for (let i = 0; i < n; i++) {
    await queue.add(`delivery-${i}`, { to: `user${i}@example.com` });
  }

  await waitUntil(async () => {
    const counts = await queue.getJobCounts('completed');
    return (counts.completed ?? 0) >= n;
  }, `${queueName}: ${n} completed jobs`);

  await worker.close();
  untrackWorker(worker);
}

/**
 * Adds `n` jobs and fails them via a throwing Worker, producing real
 * stack traces, then closes the worker for the same reason as
 * `seedCompleted`.
 */
async function seedFailed(queue: Queue, queueName: string, n: number): Promise<void> {
  const worker = new Worker<unknown, unknown, string>(
    queueName,
    async () => {
      throw new Error('seed: simulated report-generation failure');
    },
    { connection: workerConnection },
  );
  worker.on('error', () => {});
  openWorkers.push(worker);

  for (let i = 0; i < n; i++) {
    await queue.add(`report-${i}`, { period: `2026-0${(i % 9) + 1}` });
  }

  await waitUntil(async () => {
    const counts = await queue.getJobCounts('failed');
    return (counts.failed ?? 0) >= n;
  }, `${queueName}: ${n} failed jobs`);

  await worker.close();
  untrackWorker(worker);
}

interface SummaryRow {
  queue: string;
  detail: string;
}

async function seedEmailQ(): Promise<SummaryRow> {
  const emailQ = trackQueue('emailQ');
  await emailQ.obliterate({ force: true });
  // Completed first, worker closed, THEN waiting — otherwise a still-live
  // resolving worker would eat the waiting jobs too (see seedCompleted doc).
  await seedCompleted(emailQ, 'emailQ', 10, { delivered: true });
  await seedWaiting(emailQ, 30, 'welcome-email');
  return { queue: 'emailQ', detail: '10 completed, 30 waiting (3 pages)' };
}

async function seedSmsQ(): Promise<SummaryRow> {
  const smsQ = trackQueue('smsQ');
  await smsQ.obliterate({ force: true });
  await seedWaiting(smsQ, 5, 'sms-alert');
  await smsQ.pause();
  return { queue: 'smsQ', detail: 'paused, 5 waiting' };
}

async function seedReportQ(): Promise<SummaryRow> {
  const reportQ = trackQueue('reportQ');
  await reportQ.obliterate({ force: true });
  await seedFailed(reportQ, 'reportQ', 6);
  await seedDelayed(reportQ, 4, DELAYED_MS, 'monthly-report');
  return { queue: 'reportQ', detail: '6 failed (real stacktraces), 4 delayed (5m)' };
}

async function seedProgressQ(): Promise<SummaryRow> {
  const progressQ = trackQueue('progressQ');
  await progressQ.obliterate({ force: true });
  const numericJob = await progressQ.add('resize-image', { file: 'photo.png' });
  await numericJob.updateProgress(42);
  const objectJob = await progressQ.add('encode-video', { file: 'clip.mp4' });
  await objectJob.updateProgress({ stage: 'transcoding', percent: 50 });
  return {
    queue: 'progressQ',
    detail: '1 job with numeric progress (42), 1 with object progress (renders as —)',
  };
}

/**
 * Writes a raw `bull:billing:invoices:meta` hash field directly via ioredis
 * — bypassing bullmq's `Queue` constructor entirely, since that's the only
 * way a colon-containing queue name can end up in Redis (bullmq itself
 * rejects it). Demonstrates that the dashboard now handles an un-openable
 * discovered queue gracefully: it appears in the sidebar (sorted
 * alphabetically, so it lands near the top), shows an empty job list with a
 * toast rather than a fatal full-screen error, and the rest of the
 * dashboard stays fully navigable.
 */
async function seedBillingInvoices(): Promise<SummaryRow> {
  rawRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  await rawRedis.hset('bull:billing:invoices:meta', 'opts.maxLenEvents', '10000');
  return {
    queue: 'billing:invoices',
    detail:
      'un-openable (colon-named) — demonstrates the per-queue toast + empty list, not a crash',
  };
}

/**
 * Holds one job "active" on a dedicated queue for ~60s via a blocked Worker,
 * so the Active tab has something in it right after seeding. This keeps the
 * seed script alive for the duration (a detached worker would otherwise
 * keep the Node process running forever after `main()` returns) — it's
 * opt-in via `--hold` precisely because of that tradeoff; the default run
 * seeds everything else and exits immediately.
 */
async function seedActiveQ(summary: SummaryRow[]): Promise<void> {
  console.log(
    `--hold: holding one job "active" on activeQ for ~${HOLD_DURATION_MS / 1000}s, then releasing and exiting.`,
  );

  const activeQ = trackQueue('activeQ');
  await activeQ.obliterate({ force: true });

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const worker = new Worker<unknown, unknown, string>(
    'activeQ',
    async () => {
      await gate;
      return { held: true };
    },
    { connection: workerConnection },
  );
  worker.on('error', () => {});
  openWorkers.push(worker);

  await activeQ.add('long-running-job', {});

  await waitUntil(async () => {
    const counts = await activeQ.getJobCounts('active');
    return (counts.active ?? 0) >= 1;
  }, 'activeQ: 1 active job');

  summary.push({ queue: 'activeQ', detail: '1 job held active (~60s)' });
  printSummary(summary);

  await new Promise((resolve) => setTimeout(resolve, HOLD_DURATION_MS));

  release();
  await waitUntil(async () => {
    const counts = await activeQ.getJobCounts('completed');
    return (counts.completed ?? 0) >= 1;
  }, 'activeQ: held job released');

  await worker.close();
  untrackWorker(worker);
  console.log('activeQ: held job released.');
}

function printSummary(rows: SummaryRow[]): void {
  console.log('\nSeeded queues:');
  console.table(rows);
}

/**
 * Fails fast if Redis isn't reachable, instead of letting bullmq's `Queue`
 * (default `retryStrategy`: retry forever with backoff) hang indefinitely
 * and spam reconnection errors to the console. Uses its own short-lived
 * client with a non-retrying strategy so a single failed attempt rejects
 * immediately and surfaces through `main().catch` (see
 * `describeSeedFailure`) instead of looping forever.
 */
async function assertRedisReachable(): Promise<void> {
  const probe = new Redis(redisUrl, {
    lazyConnect: true,
    retryStrategy: () => null,
  });
  // Always attach an 'error' listener: ioredis logs an "Unhandled error
  // event" warning (and, without a listener at all, can crash the process)
  // on every failed connection attempt. It also carries the actual cause
  // (e.g. an `ECONNREFUSED` `AggregateError`) — `connect()`'s own rejection
  // can surface a less specific "Connection is closed" once retrying stops,
  // so the first captured error, if any, is preferred below.
  let firstError: unknown;
  probe.on('error', (err) => {
    firstError ??= err;
  });
  try {
    await probe.connect();
  } catch (err) {
    throw firstError ?? err;
  } finally {
    probe.disconnect();
  }
}

async function main(): Promise<void> {
  console.log(`Seeding demo data into ${redisUrl} ...`);
  await assertRedisReachable();
  console.warn(
    `About to obliterate (force) and reseed: ${targetQueueNames.join(', ')}. ` +
      'Any existing data in these queues will be permanently lost. ' +
      "Also (re)writing a raw 'bull:billing:invoices:meta' key (harmless idempotent HSET, not a bullmq queue).",
  );

  const summary: SummaryRow[] = [];
  summary.push(await seedBillingInvoices());
  summary.push(await seedEmailQ());
  summary.push(await seedSmsQ());
  summary.push(await seedReportQ());
  summary.push(await seedProgressQ());

  if (hold) {
    await seedActiveQ(summary);
  } else {
    console.log(
      'Default run: skipping the held-active-job demo (Active tab stays empty). ' +
        'Pass --hold to also hold one job "active" on activeQ for ~60s (this keeps ' +
        'the script running for that long; a detached worker would otherwise keep ' +
        'the process alive forever, so this is opt-in).',
    );
    printSummary(summary);
  }
}

function describeSeedFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ECONNREFUSED') {
    return `Could not connect to Redis at ${redisUrl}. Is Redis running? Try \`npm run redis:up\`.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Seed failed: ${message}`;
}

main()
  .catch((error: unknown) => {
    console.error(describeSeedFailure(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all(openWorkers.map((worker) => worker.close()));
    await Promise.all(openQueues.map((queue) => queue.close()));
    rawRedis?.disconnect();
  });

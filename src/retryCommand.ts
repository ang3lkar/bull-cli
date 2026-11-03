import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { connectionFromUrl } from './config.js';
import { retryFailedJobs } from './core/actions.js';
import { createQueueRegistry } from './core/queueRegistry.js';
import { createDoctorRedisClient, describeError } from './core/redis.js';
import type { RetrySummary } from './core/types.js';

/** The meow flags `bull-cli retry` reads. */
export interface RetryFlags {
  queue?: string;
  jobId?: string;
  since?: string;
  dryRun?: boolean;
  yes?: boolean;
  output?: string;
}

/** A validated `bull-cli retry` invocation. */
export interface RetryCommandOptions {
  queue: string;
  jobId?: string;
  /** The `--since` window, in milliseconds. */
  sinceMs?: number;
  dryRun: boolean;
}

export type ParseRetryResult =
  | { ok: true; options: RetryCommandOptions }
  | { ok: false; error: string };

const DURATION_UNITS_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/** Parses a `--since` duration such as `30s`, `15m`, `2h`, `7d` or `1w` into milliseconds; `null` if invalid. */
export function parseDuration(text: string): number | null {
  const match = /^(\d+)([smhdw])$/.exec(text.trim());
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  return amount > 0 ? amount * DURATION_UNITS_MS[match[2]] : null;
}

/**
 * Validates `bull-cli retry`'s arguments. `extra` is any positional input
 * after the `retry` command itself, which is always an error. The command
 * changes data, so it refuses to run unless the caller says which of a dry
 * run or the real thing they want. `--job-id` and `--since` are mutually
 * exclusive: a single job either failed within the window or it didn't, so
 * combining them only adds a way to be surprised.
 */
export function parseRetryArgs(extra: string[], flags: RetryFlags): ParseRetryResult {
  if (extra.length > 0) {
    return { ok: false, error: `unknown command "retry ${extra.join(' ')}"` };
  }
  if (flags.output !== undefined && flags.output !== 'json') {
    return {
      ok: false,
      error: `unsupported --output value "${flags.output}" (retry always prints JSON)`,
    };
  }
  const queue = flags.queue?.trim();
  if (!queue) {
    return { ok: false, error: 'retry requires --queue <name>' };
  }
  if (flags.dryRun && flags.yes) {
    return { ok: false, error: 'pass either --dry-run or --yes, not both' };
  }
  if (!flags.dryRun && !flags.yes) {
    return {
      ok: false,
      error: 'retry changes jobs: pass --dry-run to preview, or --yes to retry',
    };
  }
  if (flags.jobId !== undefined && flags.since !== undefined) {
    return { ok: false, error: '--job-id and --since cannot be combined' };
  }
  if (flags.jobId !== undefined && flags.jobId.trim() === '') {
    return { ok: false, error: '--job-id requires a job id' };
  }

  const options: RetryCommandOptions = { queue, dryRun: flags.dryRun === true };
  if (flags.jobId !== undefined) {
    options.jobId = flags.jobId.trim();
  }
  if (flags.since !== undefined) {
    const sinceMs = parseDuration(flags.since);
    if (sinceMs === null) {
      return {
        ok: false,
        error: `invalid --since "${flags.since}" (use a number and a unit: s, m, h, d or w, e.g. 2h)`,
      };
    }
    options.sinceMs = sinceMs;
  }
  return { ok: true, options };
}

/** The JSON `bull-cli retry` prints. */
export interface RetryReport extends RetrySummary {
  queue: string;
  dryRun: boolean;
  /** Which failed jobs were selected; empty for "all of them". */
  filter: { jobId?: string; failedSince?: string };
}

export interface RetryCommandDeps {
  redisUrl: string;
  prefix: string;
  now: () => number;
  /** Fail-fast client used to check the connection and that the queue exists. */
  createClient?: (url: string) => Redis;
  /** Runs the retry on an opened queue; defaults to `retryFailedJobs`. */
  retry?: typeof retryFailedJobs;
}

function failure(message: string): RetrySummary {
  return { matched: 0, retried: 0, errored: 0, errors: [{ jobId: null, message }] };
}

/**
 * Runs `bull-cli retry`. Never throws: an unreachable Redis, a queue that
 * doesn't exist or can't be opened, and per-job failures all end up in the
 * report's `errors`, and `retryExitCode` turns any of them into exit code 1.
 *
 * The queue is checked with a fail-fast client first (its `meta` key, the
 * same marker discovery looks for). Otherwise a typo'd queue name would
 * report "0 retried" and succeed, and an unreachable Redis would hang,
 * because bullmq's own connection retries forever.
 */
export async function runRetry(
  options: RetryCommandOptions,
  deps: RetryCommandDeps,
): Promise<RetryReport> {
  const failedSince = options.sinceMs === undefined ? undefined : deps.now() - options.sinceMs;
  const report = (result: RetrySummary): RetryReport => ({
    queue: options.queue,
    dryRun: options.dryRun,
    filter: {
      ...(options.jobId !== undefined ? { jobId: options.jobId } : {}),
      ...(failedSince !== undefined ? { failedSince: new Date(failedSince).toISOString() } : {}),
    },
    ...result,
  });

  const client = (deps.createClient ?? createDoctorRedisClient)(deps.redisUrl);
  try {
    await client.connect();
    const exists = await client.exists(`${deps.prefix}:${options.queue}:meta`);
    if (exists === 0) {
      return report(failure(`Queue "${options.queue}" not found under prefix "${deps.prefix}"`));
    }
  } catch (err) {
    const message = err instanceof Error ? describeError(err) : String(err);
    return report(failure(`Could not connect to Redis: ${message}`));
  } finally {
    client.disconnect();
  }

  const registry = createQueueRegistry(connectionFromUrl(deps.redisUrl), deps.prefix);
  try {
    let queue: Queue;
    try {
      queue = registry.getQueue(options.queue);
    } catch (err) {
      return report(failure(err instanceof Error ? err.message : String(err)));
    }
    const retry = deps.retry ?? retryFailedJobs;
    return report(
      await retry(queue, { jobId: options.jobId, failedSince, dryRun: options.dryRun }),
    );
  } finally {
    await registry.closeAll();
  }
}

/** 1 when anything went wrong (a failed retry, a missing queue, no connection), otherwise 0. */
export function retryExitCode(report: RetryReport): number {
  return report.errored > 0 || report.errors.length > 0 ? 1 : 0;
}

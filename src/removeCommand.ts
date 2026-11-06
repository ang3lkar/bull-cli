import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { connectionFromUrl } from './config.js';
import { removeQueue } from './core/actions.js';
import { fetchQueueCounts } from './core/jobs.js';
import { createQueueRegistry } from './core/queueRegistry.js';
import { createDoctorRedisClient, describeError } from './core/redis.js';
import type { JobStatus } from './core/types.js';

/** The meow flags `bull-cli remove` reads. */
export interface RemoveFlags {
  queue?: string;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
  output?: string;
}

/** A validated `bull-cli remove` invocation. */
export interface RemoveCommandOptions {
  queue: string;
  dryRun: boolean;
  force: boolean;
}

export type ParseRemoveResult =
  | { ok: true; options: RemoveCommandOptions }
  | { ok: false; error: string };

/**
 * Validates `bull-cli remove`'s arguments. Like `retry`, it refuses to run
 * unless the caller picks `--dry-run` or `--yes`: removing a queue can't be
 * undone, so it never happens by accident of a missing flag.
 */
export function parseRemoveArgs(extra: string[], flags: RemoveFlags): ParseRemoveResult {
  if (extra.length > 0) {
    return { ok: false, error: `unknown command "remove ${extra.join(' ')}"` };
  }
  if (flags.output !== undefined && flags.output !== 'json') {
    return {
      ok: false,
      error: `unsupported --output value "${flags.output}" (remove always prints JSON)`,
    };
  }
  const queue = flags.queue?.trim();
  if (!queue) {
    return { ok: false, error: 'remove requires --queue <name>' };
  }
  if (flags.dryRun && flags.yes) {
    return { ok: false, error: 'pass either --dry-run or --yes, not both' };
  }
  if (!flags.dryRun && !flags.yes) {
    return {
      ok: false,
      error:
        'remove deletes the queue and all its jobs: pass --dry-run to preview, or --yes to remove',
    };
  }
  return {
    ok: true,
    options: { queue, dryRun: flags.dryRun === true, force: flags.force === true },
  };
}

/** The JSON `bull-cli remove` prints. */
export interface RemoveReport {
  queue: string;
  dryRun: boolean;
  force: boolean;
  /** Jobs per status when the command ran, or `null` if they couldn't be read. */
  counts: Record<JobStatus, number> | null;
  /** Sum of `counts`, or `null` alongside it. */
  total: number | null;
  removed: boolean;
  /** Why nothing was removed, or `null` on success (and on a clean dry run). */
  error: string | null;
}

export interface RemoveCommandDeps {
  redisUrl: string;
  prefix: string;
  /** Fail-fast client used to check the connection and that the queue exists. */
  createClient?: (url: string) => Redis;
  /** Reads job counts from an opened queue; defaults to `fetchQueueCounts`. */
  countJobs?: (queue: Queue) => Promise<Record<JobStatus, number>>;
  /** Removes an opened queue; defaults to `removeQueue`. */
  remove?: typeof removeQueue;
}

/**
 * Runs `bull-cli remove`. Never throws: an unreachable Redis, a queue that
 * doesn't exist or can't be opened, and a refused removal all end up in the
 * report's `error`, which `removeExitCode` turns into exit code 1.
 *
 * The queue is checked with a fail-fast client before bullmq is involved,
 * as in `runRetry`. Here that matters twice over: opening a bullmq `Queue`
 * writes its `meta` hash, so a typo'd name would otherwise create the very
 * queue the user meant to remove, and a dry run would "succeed" on it.
 */
export async function runRemove(
  options: RemoveCommandOptions,
  deps: RemoveCommandDeps,
): Promise<RemoveReport> {
  const report = (fields: Partial<RemoveReport>): RemoveReport => ({
    queue: options.queue,
    dryRun: options.dryRun,
    force: options.force,
    counts: null,
    total: null,
    removed: false,
    error: null,
    ...fields,
  });

  const client = (deps.createClient ?? createDoctorRedisClient)(deps.redisUrl);
  try {
    await client.connect();
    const exists = await client.exists(`${deps.prefix}:${options.queue}:meta`);
    if (exists === 0) {
      return report({
        error: `Queue "${options.queue}" not found under prefix "${deps.prefix}"`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? describeError(err) : String(err);
    return report({ error: `Could not connect to Redis: ${message}` });
  } finally {
    client.disconnect();
  }

  const registry = createQueueRegistry(connectionFromUrl(deps.redisUrl), deps.prefix);
  try {
    let queue: Queue;
    try {
      queue = registry.getQueue(options.queue);
    } catch (err) {
      return report({ error: err instanceof Error ? err.message : String(err) });
    }

    let counts: Record<JobStatus, number> | null = null;
    try {
      counts = await (deps.countJobs ?? fetchQueueCounts)(queue);
    } catch {
      // Counts are informational; a failure to read them shouldn't block removal.
    }
    const total = counts === null ? null : Object.values(counts).reduce((a, b) => a + b, 0);
    if (options.dryRun) {
      return report({ counts, total });
    }

    const result = await (deps.remove ?? removeQueue)(queue, { force: options.force });
    return result.ok
      ? report({ counts, total, removed: true })
      : report({ counts, total, error: result.message });
  } finally {
    await registry.closeAll();
  }
}

/** 1 when anything went wrong (a refused removal, a missing queue, no connection), otherwise 0. */
export function removeExitCode(report: RemoveReport): number {
  return report.error === null ? 0 : 1;
}

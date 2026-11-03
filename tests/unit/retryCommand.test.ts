import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import {
  parseDuration,
  parseRetryArgs,
  type RetryReport,
  retryExitCode,
  runRetry,
} from '../../src/retryCommand.js';

describe('parseDuration', () => {
  it.each([
    ['30s', 30_000],
    ['15m', 15 * 60_000],
    ['2h', 2 * 3_600_000],
    ['7d', 7 * 86_400_000],
    ['1w', 7 * 86_400_000],
    [' 5m ', 5 * 60_000],
  ])('parses %j', (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it.each(['', '2', 'h', '2x', '1.5h', '-1h', '0m', '2 h', '2hours'])('rejects %j', (text) => {
    expect(parseDuration(text)).toBeNull();
  });
});

describe('parseRetryArgs', () => {
  it('accepts a queue with --yes', () => {
    expect(parseRetryArgs([], { queue: 'email', yes: true })).toEqual({
      ok: true,
      options: { queue: 'email', dryRun: false },
    });
  });

  it('accepts --dry-run with --job-id', () => {
    expect(parseRetryArgs([], { queue: 'email', dryRun: true, jobId: ' 42 ' })).toEqual({
      ok: true,
      options: { queue: 'email', dryRun: true, jobId: '42' },
    });
  });

  it('accepts --since and converts it to milliseconds', () => {
    expect(parseRetryArgs([], { queue: 'email', yes: true, since: '2h' })).toEqual({
      ok: true,
      options: { queue: 'email', dryRun: false, sinceMs: 7_200_000 },
    });
  });

  it('accepts an explicit --output json', () => {
    expect(parseRetryArgs([], { queue: 'q', yes: true, output: 'json' }).ok).toBe(true);
  });

  it.each([
    [[], {}, 'retry requires --queue <name>'],
    [[], { queue: '  ', yes: true }, 'retry requires --queue <name>'],
    [[], { queue: 'q' }, 'pass --dry-run to preview, or --yes to retry'],
    [[], { queue: 'q', dryRun: true, yes: true }, 'not both'],
    [[], { queue: 'q', yes: true, jobId: '1', since: '1h' }, 'cannot be combined'],
    [[], { queue: 'q', yes: true, jobId: '' }, '--job-id requires a job id'],
    [[], { queue: 'q', yes: true, since: 'soon' }, 'invalid --since "soon"'],
    [[], { queue: 'q', yes: true, output: 'table' }, 'unsupported --output value "table"'],
    [['extra'], { queue: 'q', yes: true }, 'unknown command "retry extra"'],
  ] as const)('rejects %j %j', (extra, flags, message) => {
    const result = parseRetryArgs([...extra], flags);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain(message);
  });
});

describe('retryExitCode', () => {
  const base: RetryReport = {
    queue: 'q',
    dryRun: false,
    filter: {},
    matched: 2,
    retried: 2,
    errored: 0,
    errors: [],
  };

  it('is 0 for a clean run and 1 when anything errored', () => {
    expect(retryExitCode(base)).toBe(0);
    expect(retryExitCode({ ...base, retried: 1, errored: 1 })).toBe(1);
    expect(retryExitCode({ ...base, errors: [{ jobId: null, message: 'x' }] })).toBe(1);
  });
});

/** A fake fail-fast client; only `connect`, `exists` and `disconnect` are used. */
function fakeClient(overrides: Partial<Record<'connect' | 'exists', () => Promise<unknown>>>) {
  const client = {
    connect: vi.fn(async () => undefined),
    exists: vi.fn(async () => 1),
    disconnect: vi.fn(),
    ...overrides,
  };
  return client;
}

describe('runRetry (before any queue is opened)', () => {
  const deps = { redisUrl: 'redis://localhost:6390', prefix: 'bull', now: () => 1_000_000 };

  it('reports an unreachable Redis as an error, and disconnects', async () => {
    const client = fakeClient({
      connect: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const report = await runRetry(
      { queue: 'email', dryRun: true },
      { ...deps, createClient: () => client as unknown as Redis },
    );
    expect(report.errors).toEqual([
      { jobId: null, message: 'Could not connect to Redis: connect ECONNREFUSED' },
    ]);
    expect(retryExitCode(report)).toBe(1);
    expect(client.disconnect).toHaveBeenCalled();
  });

  it('reports a non-Error throw too', async () => {
    const client = fakeClient({
      exists: async () => {
        throw 'weird';
      },
    });
    const report = await runRetry(
      { queue: 'email', dryRun: true },
      { ...deps, createClient: () => client as unknown as Redis },
    );
    expect(report.errors[0].message).toBe('Could not connect to Redis: weird');
  });

  it('reports a queue that does not exist, checking its meta key under the prefix', async () => {
    const client = fakeClient({ exists: vi.fn(async () => 0) });
    const report = await runRetry(
      { queue: 'emial', dryRun: false, sinceMs: 60_000 },
      { ...deps, prefix: 'myapp', createClient: () => client as unknown as Redis },
    );
    expect(client.exists).toHaveBeenCalledWith('myapp:emial:meta');
    expect(report).toEqual({
      queue: 'emial',
      dryRun: false,
      filter: { failedSince: new Date(1_000_000 - 60_000).toISOString() },
      matched: 0,
      retried: 0,
      errored: 0,
      errors: [{ jobId: null, message: 'Queue "emial" not found under prefix "myapp"' }],
    });
    expect(retryExitCode(report)).toBe(1);
  });

  it('reports a queue name bullmq refuses to open', async () => {
    const retry = vi.fn();
    const report = await runRetry(
      { queue: 'billing:invoices', dryRun: true, jobId: '7' },
      { ...deps, createClient: () => fakeClient({}) as unknown as Redis, retry },
    );
    expect(report.filter).toEqual({ jobId: '7' });
    expect(report.errors[0].message).toContain(':');
    expect(retry).not.toHaveBeenCalled();
  });
});

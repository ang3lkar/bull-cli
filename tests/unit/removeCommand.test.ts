import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import {
  parseRemoveArgs,
  type RemoveReport,
  removeExitCode,
  runRemove,
} from '../../src/removeCommand.js';

function fakeClient(overrides: Record<string, unknown>) {
  return {
    connect: vi.fn(async () => {}),
    exists: vi.fn(async () => 1),
    disconnect: vi.fn(),
    ...overrides,
  };
}

describe('parseRemoveArgs', () => {
  it('accepts a queue with --yes, and --force', () => {
    expect(parseRemoveArgs([], { queue: ' email ', yes: true })).toEqual({
      ok: true,
      options: { queue: 'email', dryRun: false, force: false },
    });
    expect(parseRemoveArgs([], { queue: 'email', yes: true, force: true })).toEqual({
      ok: true,
      options: { queue: 'email', dryRun: false, force: true },
    });
  });

  it('accepts --dry-run and an explicit --output json', () => {
    expect(parseRemoveArgs([], { queue: 'q', dryRun: true, output: 'json' })).toEqual({
      ok: true,
      options: { queue: 'q', dryRun: true, force: false },
    });
  });

  it.each([
    [['extra'], { queue: 'q', yes: true }, 'unknown command "remove extra"'],
    [[], { queue: 'q', yes: true, output: 'table' }, 'remove always prints JSON'],
    [[], {}, 'remove requires --queue <name>'],
    [[], { queue: '  ', yes: true }, 'remove requires --queue <name>'],
    [[], { queue: 'q', dryRun: true, yes: true }, 'not both'],
    [[], { queue: 'q' }, 'pass --dry-run to preview, or --yes to remove'],
    [[], { queue: 'q', force: true }, 'pass --dry-run to preview, or --yes to remove'],
  ])('rejects %j %j', (extra, flags, message) => {
    const result = parseRemoveArgs(extra, flags);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain(message);
  });
});

describe('removeExitCode', () => {
  const base: RemoveReport = {
    queue: 'q',
    dryRun: false,
    force: false,
    counts: null,
    total: null,
    removed: true,
    error: null,
  };

  it('is 0 without an error and 1 with one', () => {
    expect(removeExitCode(base)).toBe(0);
    expect(removeExitCode({ ...base, removed: false, error: 'nope' })).toBe(1);
  });
});

describe('runRemove (before any queue is opened)', () => {
  const deps = { redisUrl: 'redis://localhost:6390', prefix: 'bull' };
  const options = { queue: 'email', dryRun: false, force: false };

  it('reports an unreachable Redis as an error, and disconnects', async () => {
    const client = fakeClient({
      connect: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const remove = vi.fn();
    const report = await runRemove(options, {
      ...deps,
      createClient: () => client as unknown as Redis,
      remove,
    });
    expect(report.error).toBe('Could not connect to Redis: connect ECONNREFUSED');
    expect(report.removed).toBe(false);
    expect(removeExitCode(report)).toBe(1);
    expect(client.disconnect).toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('reports a non-Error throw too', async () => {
    const client = fakeClient({
      exists: async () => {
        throw 'weird';
      },
    });
    const report = await runRemove(options, {
      ...deps,
      createClient: () => client as unknown as Redis,
    });
    expect(report.error).toBe('Could not connect to Redis: weird');
  });

  it('reports a queue that does not exist without opening it, so it is never created', async () => {
    const client = fakeClient({ exists: vi.fn(async () => 0) });
    const remove = vi.fn();
    const report = await runRemove(
      { queue: 'emial', dryRun: true, force: true },
      { ...deps, prefix: 'myapp', createClient: () => client as unknown as Redis, remove },
    );
    expect(client.exists).toHaveBeenCalledWith('myapp:emial:meta');
    expect(report).toEqual({
      queue: 'emial',
      dryRun: true,
      force: true,
      counts: null,
      total: null,
      removed: false,
      error: 'Queue "emial" not found under prefix "myapp"',
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it('reports a queue name bullmq refuses to open', async () => {
    const remove = vi.fn();
    const report = await runRemove(
      { ...options, queue: 'billing:invoices' },
      { ...deps, createClient: () => fakeClient({}) as unknown as Redis, remove },
    );
    expect(report.error).toContain(':');
    expect(remove).not.toHaveBeenCalled();
  });
});

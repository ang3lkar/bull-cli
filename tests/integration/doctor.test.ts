import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Check, type DoctorDeps, runDoctor } from '../../src/core/doctor.js';
import { createDoctorRedisClient } from '../../src/core/redis.js';

// Taken: 1-7 and 13-15 (see AGENTS.md); never DB 0 (seed).
const DOCTOR_DB = 8;
const URL = `redis://localhost:6379/${DOCTOR_DB}`;

let redis: Redis;

function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    redisFlag: URL,
    prefixFlag: undefined,
    env: {},
    configPaths: { user: '/nonexistent/user.json', project: '/nonexistent/project.json' },
    fileExists: () => false,
    readFile: () => '',
    createClient: createDoctorRedisClient,
    now: () => performance.now(),
    version: 'test',
    ...overrides,
  };
}

const get = (checks: Check[], id: string) => checks.find((c) => c.id === id) as Check;

beforeAll(() => {
  redis = new Redis(URL, { maxRetriesPerRequest: null });
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await redis.flushdb();
  redis.disconnect();
});

describe('runDoctor (real Redis)', () => {
  it('is all ok when a queue exists', async () => {
    const queue = new Queue('docQ', {
      connection: { host: 'localhost', port: 6379, db: DOCTOR_DB },
    });
    await queue.waitUntilReady();
    try {
      const report = await runDoctor(deps());
      expect(report.summary).toEqual({ ok: 5, warn: 0, fail: 0, skip: 0 });
      expect(get(report.checks, 'connection').message).toContain(`DB ${DOCTOR_DB}`);
      expect(get(report.checks, 'ping').message).toMatch(/^PONG in \d+ms$/);
      expect(get(report.checks, 'server').message).toMatch(/^Redis \d+\.\d+\.\d+ \(standalone\)$/);
      expect(get(report.checks, 'queues').message).toBe('1 queue: docQ');
    } finally {
      await queue.close();
    }
  });

  it('warns with a prefix hint when queues live under another prefix', async () => {
    const queue = new Queue('otherQ', {
      prefix: 'myapp',
      connection: { host: 'localhost', port: 6379, db: DOCTOR_DB },
    });
    // Adding a job makes bullmq write `opts.maxLenEvents` into the meta hash,
    // which is what the doctor's prefix heuristic verifies.
    await queue.add('job', {});
    try {
      const report = await runDoctor(deps());
      const queues = get(report.checks, 'queues');
      expect(queues.status).toBe('warn');
      // Prefix hint only; other DBs' contents (shared Redis) must not leak in.
      expect(queues.hint).toBe('Queues exist under prefix "myapp" (1). Try --prefix myapp.');
      expect(queues.hint).not.toContain('Other databases');
      expect(report.summary.fail).toBe(0);
    } finally {
      await queue.close();
    }
  });

  it('skips later checks when Redis is unreachable', async () => {
    const report = await runDoctor(deps({ redisFlag: 'redis://localhost:1' }));
    expect(get(report.checks, 'ping').status).toBe('fail');
    expect(get(report.checks, 'ping').message).toMatch(/ECONNREFUSED/);
    expect(get(report.checks, 'server').status).toBe('skip');
    expect(get(report.checks, 'queues').status).toBe('skip');
  });

  it('fails ping with the auth hint for wrong credentials', async () => {
    const report = await runDoctor(
      deps({ redisFlag: `redis://u:wrong@localhost:6379/${DOCTOR_DB}` }),
    );
    const ping = get(report.checks, 'ping');
    expect(ping.status).toBe('fail');
    expect(ping.hint).toBe(
      'Redis rejected the credentials. Check the username/password in the URL (or ?password=).',
    );
    expect(JSON.stringify(report)).not.toContain('wrong@');
    expect(get(report.checks, 'queues').status).toBe('skip');
  });

  it('fails ping with the DB hint for an out-of-range database', async () => {
    const report = await runDoctor(deps({ redisFlag: 'redis://localhost:6379/99' }));
    const ping = get(report.checks, 'ping');
    expect(ping.status).toBe('fail');
    expect(ping.hint).toBe("The database number in the URL doesn't exist on this server.");
    expect(get(report.checks, 'server').status).toBe('skip');
  });
});

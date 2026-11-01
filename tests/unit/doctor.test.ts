import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import {
  type DoctorDeps,
  doctorExitCode,
  formatDoctorReport,
  runDoctor,
} from '../../src/core/doctor.js';

interface FakeOpts {
  connect?: () => Promise<void>;
  ping?: () => Promise<string>;
  info?: (section: string) => Promise<string>;
  scan?: (...args: unknown[]) => Promise<[string, string[]]>;
  pipelineResults?: Array<[Error | null, number]>;
  /** Which keys HEXISTS reports as BullMQ meta hashes when `pipelineResults` isn't set (default: all). */
  metaValid?: (key: string) => boolean;
}

function fakeRedis(opts: FakeOpts = {}) {
  const disconnect = vi.fn();
  const handlers: Array<(e: Error) => void> = [];
  const client = {
    on: (_event: string, handler: (e: Error) => void) => {
      handlers.push(handler);
    },
    connect: opts.connect ?? (async () => {}),
    ping: opts.ping ?? (async () => 'PONG'),
    info:
      opts.info ??
      (async (section: string) =>
        section === 'server'
          ? '# Server\r\nredis_version:7.2.4\r\nredis_mode:standalone\r\n'
          : '# Keyspace\r\n'),
    scan: opts.scan ?? (async () => ['0', []] as [string, string[]]),
    pipeline: () => {
      const keys: string[] = [];
      const p = {
        hexists: (key: string) => {
          keys.push(key);
          return p;
        },
        exec: async () =>
          opts.pipelineResults ??
          keys.map((k) => [null, (opts.metaValid ?? (() => true))(k) ? 1 : 0]),
      };
      return p;
    },
    disconnect,
  };
  const emitError = (e: Error) => {
    for (const h of handlers) h(e);
  };
  return { client: client as unknown as Redis, disconnect, emitError };
}

function makeDeps(redis: Redis, overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  let t = 100;
  return {
    redisFlag: undefined,
    prefixFlag: undefined,
    env: {},
    configPaths: { user: '/u/config.json', project: '/p/bull-cli.json' },
    fileExists: () => false,
    readFile: () => '',
    createClient: () => redis,
    now: () => {
      t += 2;
      return t;
    },
    version: '1.2.3',
    ...overrides,
  };
}

const byId = (r: { checks: Array<{ id: string }> }, id: string) =>
  r.checks.find((c) => c.id === id) as import('../../src/core/doctor.js').Check;

const metaScan = (keys: string[]) => async () => ['0', keys] as [string, string[]];

describe('runDoctor', () => {
  it('reports all ok with queues, in the specified order', async () => {
    const { client, disconnect } = fakeRedis({
      scan: metaScan(['bull:a:meta', 'bull:b:meta']),
      pipelineResults: [
        [null, 0],
        [null, 0],
      ],
    });
    const report = await runDoctor(makeDeps(client));
    expect(report.checks.map((c) => c.id)).toEqual([
      'config',
      'connection',
      'ping',
      'server',
      'queues',
    ]);
    expect(report.version).toBe('1.2.3');
    expect(report.summary).toEqual({ ok: 5, warn: 0, fail: 0, skip: 0 });
    expect(byId(report, 'config').message).toBe('No config files (using defaults)');
    expect(byId(report, 'connection').message).toBe(
      'redis://localhost:6379 (default), DB 0, prefix "bull" (default)',
    );
    expect(byId(report, 'ping').message).toBe('PONG in 2ms');
    expect(byId(report, 'server').message).toBe('Redis 7.2.4 (standalone)');
    expect(byId(report, 'queues').message).toBe('2 queues: a, b');
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(doctorExitCode(report)).toBe(0);
  });

  it('names flag/env sources and the DB', async () => {
    const { client } = fakeRedis();
    const report = await runDoctor(
      makeDeps(client, {
        redisFlag: 'redis://h:6379/3',
        env: { BULLMQ_PREFIX: 'myapp' },
      }),
    );
    expect(byId(report, 'connection').message).toBe(
      'redis://h:6379/3 (--redis), DB 3, prefix "myapp" (BULLMQ_PREFIX)',
    );
    const r2 = await runDoctor(
      makeDeps(client, { env: { REDIS_URL: 'redis://e:6379' }, prefixFlag: 'x' }),
    );
    expect(byId(r2, 'connection').message).toBe(
      'redis://e:6379 (REDIS_URL), DB 0, prefix "x" (--prefix)',
    );
  });

  describe('config', () => {
    it('is ok and names valid files', async () => {
      const { client } = fakeRedis();
      const report = await runDoctor(
        makeDeps(client, {
          fileExists: (p) => p === '/u/config.json',
          readFile: () => '{ "refreshIntervalMs": 1000 }',
        }),
      );
      expect(byId(report, 'config')).toMatchObject({
        status: 'ok',
        message: 'Valid config: /u/config.json',
      });
    });

    it('fails with the ConfigError message but keeps going', async () => {
      const { client } = fakeRedis();
      const report = await runDoctor(
        makeDeps(client, {
          fileExists: () => true,
          readFile: (p) => (p === '/u/config.json' ? '{ "bogus": 1 }' : '{ nope'),
        }),
      );
      const config = byId(report, 'config');
      expect(config.status).toBe('fail');
      expect(config.message).toContain('/u/config.json: unknown config key "bogus"');
      expect(config.message).toContain('/p/bull-cli.json');
      expect(byId(report, 'ping').status).toBe('ok');
      expect(doctorExitCode(report)).toBe(1);
    });

    it('fails when a file cannot be read', async () => {
      const { client } = fakeRedis();
      const report = await runDoctor(
        makeDeps(client, {
          fileExists: () => true,
          readFile: () => {
            throw new Error('EACCES');
          },
        }),
      );
      expect(byId(report, 'config').status).toBe('fail');
      expect(byId(report, 'config').message).toContain('EACCES');
    });
  });

  describe('connection', () => {
    it('fails for an unparseable URL and skips the Redis checks without creating a client', async () => {
      const createClient = vi.fn();
      const report = await runDoctor(
        makeDeps({} as Redis, { redisFlag: 'not a url', createClient }),
      );
      expect(byId(report, 'connection').status).toBe('fail');
      expect(['ping', 'server', 'queues'].map((id) => byId(report, id).status)).toEqual([
        'skip',
        'skip',
        'skip',
      ]);
      expect(createClient).not.toHaveBeenCalled();
      expect(report.summary).toEqual({ ok: 1, warn: 0, fail: 1, skip: 3 });
    });

    it('fails for a non-numeric DB', async () => {
      const report = await runDoctor(
        makeDeps({} as Redis, { redisFlag: 'redis://localhost:6379/abc' }),
      );
      expect(byId(report, 'connection').status).toBe('fail');
    });
  });

  describe('ping', () => {
    it('fails fast, skips later checks, and still closes the client', async () => {
      const { client, disconnect } = fakeRedis({
        connect: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:1');
        },
      });
      const report = await runDoctor(makeDeps(client));
      expect(byId(report, 'ping')).toMatchObject({
        status: 'fail',
        message: 'connect ECONNREFUSED 127.0.0.1:1',
      });
      expect(byId(report, 'server').status).toBe('skip');
      expect(byId(report, 'queues').status).toBe('skip');
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(doctorExitCode(report)).toBe(1);
    });

    it('prefers the underlying connection error event over the generic rejection', async () => {
      const ref: { emit?: (e: Error) => void } = {};
      const { client, emitError } = fakeRedis({
        connect: async () => {
          ref.emit?.(new Error('connect ECONNREFUSED 127.0.0.1:1 for redis://u:pw0rd@h:1'));
          throw new Error('Connection is closed.');
        },
      });
      ref.emit = emitError;
      const report = await runDoctor(makeDeps(client));
      expect(byId(report, 'ping').message).toBe(
        'connect ECONNREFUSED 127.0.0.1:1 for redis://u:****@h:1',
      );
      expect(JSON.stringify(report)).not.toContain('pw0rd');
    });

    it('fails when PING itself rejects', async () => {
      const { client } = fakeRedis({
        ping: async () => {
          throw new Error('NOAUTH Authentication required.');
        },
      });
      const report = await runDoctor(makeDeps(client));
      expect(byId(report, 'ping').message).toBe('NOAUTH Authentication required.');
    });

    it('clamps negative latency to 0 and survives a throwing disconnect', async () => {
      const { client } = fakeRedis();
      (client as unknown as { disconnect: () => void }).disconnect = () => {
        throw new Error('x');
      };
      let calls = 0;
      const report = await runDoctor(makeDeps(client, { now: () => 10 - calls++ }));
      expect(byId(report, 'ping').message).toBe('PONG in 0ms');
    });

    it('rounds the latency', async () => {
      const { client } = fakeRedis();
      const times = [0, 1.6];
      const report = await runDoctor(makeDeps(client, { now: () => times.shift() ?? 0 }));
      expect(byId(report, 'ping').message).toBe('PONG in 2ms');
    });
  });

  describe('server', () => {
    it('warns (not fails) when INFO is refused, and queues still run', async () => {
      const { client } = fakeRedis({
        info: async (section) => {
          if (section === 'server') throw new Error('NOPERM no permissions to run info');
          return '';
        },
        scan: metaScan(['bull:a:meta']),
        pipelineResults: [[null, 0]],
      });
      const report = await runDoctor(makeDeps(client));
      expect(byId(report, 'server').status).toBe('warn');
      expect(byId(report, 'server').message).toContain('NOPERM');
      expect(byId(report, 'queues').status).toBe('ok');
      expect(doctorExitCode(report)).toBe(0);
    });

    it('reports unknown fields gracefully', async () => {
      const { client } = fakeRedis({ info: async () => '# Server\r\nfoo:bar\r\n' });
      const report = await runDoctor(makeDeps(client));
      expect(byId(report, 'server').message).toBe('Redis unknown version (unknown mode)');
    });
  });

  describe('queues', () => {
    it('lists at most 10 names then "and N more"; singular for one', async () => {
      const keys = Array.from({ length: 13 }, (_, i) => `bull:q${String(i).padStart(2, '0')}:meta`);
      const { client } = fakeRedis({
        scan: metaScan(keys),
        pipelineResults: keys.map(() => [null, 0] as [null, number]),
      });
      const report = await runDoctor(makeDeps(client));
      expect(byId(report, 'queues').message).toBe(
        '13 queues: q00, q01, q02, q03, q04, q05, q06, q07, q08, q09, and 3 more',
      );

      const one = fakeRedis({ scan: metaScan(['bull:x:meta']), pipelineResults: [[null, 0]] });
      const r2 = await runDoctor(makeDeps(one.client));
      expect(byId(r2, 'queues').message).toBe('1 queue: x');
    });

    it('fails when discovery throws', async () => {
      const { client } = fakeRedis({
        scan: async () => {
          throw new Error('boom');
        },
      });
      const report = await runDoctor(makeDeps(client));
      expect(byId(report, 'queues')).toMatchObject({
        status: 'fail',
        message: 'Queue discovery failed: boom',
      });
    });

    it('warns with a prefix hint when queues exist under another prefix', async () => {
      const { client } = fakeRedis({
        scan: metaScan([
          'myapp:a:meta',
          'myapp:b:meta',
          'myapp:c:meta',
          'other:z:meta',
          'junk:meta',
          ':x:meta',
        ]),
      });
      const report = await runDoctor(makeDeps(client));
      const queues = byId(report, 'queues');
      expect(queues.status).toBe('warn');
      expect(queues.message).toBe('No queues under prefix "bull"');
      expect(queues.hint).toBe(
        'Queues exist under prefix "myapp" (3), "other" (1). Try --prefix myapp.',
      );
    });

    it('warns with an other-databases hint', async () => {
      const { client } = fakeRedis({
        info: async (s) =>
          s === 'server'
            ? 'redis_version:7\r\nredis_mode:standalone'
            : '# Keyspace\r\ndb0:keys=0,expires=0\r\ndb1:keys=4,expires=0,avg_ttl=0\r\ndb3:keys=1,expires=0\r\ndb4:keys=0,expires=0\r\ndbx:keys=1\r\n',
      });
      const report = await runDoctor(makeDeps(client, { redisFlag: 'redis://u:pw@host:6379' }));
      expect(byId(report, 'queues').hint).toBe(
        'Other databases have keys: db1, db3. Try redis://u:****@host:6379/1.',
      );
    });

    it('excludes the current DB from the other-databases hint', async () => {
      const { client } = fakeRedis({
        info: async (s) => (s === 'server' ? '' : 'db0:keys=9,expires=0\r\n'),
      });
      const report = await runDoctor(makeDeps(client));
      expect(byId(report, 'queues').hint).toBe(
        'No BullMQ keys found anywhere. Is this the right Redis instance?',
      );
    });

    it('shows only the prefix hint when another prefix is found, even if other DBs have keys', async () => {
      const { client } = fakeRedis({
        scan: metaScan(['myapp:a:meta']),
        info: async (s) => (s === 'server' ? '' : 'db2:keys=1,expires=0\r\n'),
      });
      const report = await runDoctor(makeDeps(client));
      expect(byId(report, 'queues').hint).toBe(
        'Queues exist under prefix "myapp" (1). Try --prefix myapp.',
      );
    });

    it('drops the failing part of the hint but keeps the warn', async () => {
      let scans = 0;
      const { client } = fakeRedis({
        scan: async () => {
          // first pass is discovery (ok, empty); second is the hint lookup (fails)
          scans += 1;
          if (scans > 1) throw new Error('scan refused');
          return ['0', []];
        },
        info: async (s) => (s === 'server' ? '' : 'db5:keys=2,expires=0\r\n'),
      });
      const report = await runDoctor(makeDeps(client));
      const queues = byId(report, 'queues');
      expect(queues.status).toBe('warn');
      expect(queues.hint).toBe('Other databases have keys: db5. Try redis://localhost:6379/5.');
    });

    it('has no hint when every lookup errored', async () => {
      let scans = 0;
      const { client } = fakeRedis({
        scan: async () => {
          scans += 1;
          if (scans > 1) throw new Error('scan refused');
          return ['0', []];
        },
        info: async (s) => {
          if (s === 'keyspace') throw new Error('NOPERM');
          return '';
        },
      });
      const report = await runDoctor(makeDeps(client));
      expect(byId(report, 'queues').status).toBe('warn');
      expect(byId(report, 'queues').hint).toBeUndefined();
    });

    it('has no "anywhere" claim when only the keyspace lookup errored', async () => {
      const { client } = fakeRedis({
        info: async (s) => {
          if (s === 'keyspace') throw new Error('NOPERM');
          return '';
        },
      });
      const report = await runDoctor(makeDeps(client));
      expect(byId(report, 'queues').hint).toBeUndefined();
    });

    it('follows SCAN cursors in the prefix lookup', async () => {
      const calls: string[] = [];
      let n = 0;
      const { client } = fakeRedis({
        scan: async (cursor) => {
          calls.push(String(cursor));
          n += 1;
          if (n === 1) return ['0', []]; // discovery
          return n === 2 ? ['7', ['a:x:meta']] : ['0', ['a:y:meta']];
        },
      });
      const report = await runDoctor(makeDeps(client));
      expect(calls).toEqual(['0', '0', '7']);
      expect(byId(report, 'queues').hint).toContain('"a" (2)');
    });
  });

  describe('credential masking', () => {
    const secret = 's3cr3tpw';

    it('never leaks the password in either output, including error text', async () => {
      const { client } = fakeRedis({
        connect: async () => {
          throw new Error(`connect failed for redis://user:${secret}@host:6379 (pw ${secret})`);
        },
      });
      const report = await runDoctor(
        makeDeps(client, { redisFlag: `redis://user:${secret}@host:6379` }),
      );
      expect(JSON.stringify(report, null, 2)).not.toContain(secret);
      expect(formatDoctorReport(report)).not.toContain(secret);
      expect(byId(report, 'connection').message).toContain('redis://user:****@host:6379');
      expect(byId(report, 'ping').message).toContain('redis://user:****@host:6379');
    });

    it('masks URL-encoded passwords and non-Error rejections', async () => {
      const { client } = fakeRedis({
        ping: async () => {
          throw 'bad p%40ss and p@ss'; // eslint-disable-line no-throw-literal
        },
      });
      const report = await runDoctor(
        makeDeps(client, { redisFlag: 'redis://user:p%40ss@host:6379' }),
      );
      expect(JSON.stringify(report)).not.toContain('p@ss');
      expect(JSON.stringify(report)).not.toContain('p%40ss');
    });

    it('survives a malformed percent-encoded password', async () => {
      const { client } = fakeRedis({
        ping: async () => {
          throw new Error('nope %zz');
        },
      });
      const report = await runDoctor(makeDeps(client, { redisFlag: 'redis://user:%zz@host:6379' }));
      expect(JSON.stringify(report)).not.toContain('%zz');
    });

    it('never prints the password for a URL that fails to parse', async () => {
      const report = await runDoctor(
        makeDeps({} as Redis, { redisFlag: `redis://user:${secret}@[::1` }),
      );
      expect(byId(report, 'connection').status).toBe('fail');
      expect(JSON.stringify(report, null, 2)).not.toContain(secret);
      expect(formatDoctorReport(report)).not.toContain(secret);
    });

    it('masks an invalid-URL failure message', async () => {
      const report = await runDoctor(
        makeDeps({} as Redis, { redisFlag: `redis://user:${secret}@host:6379/abc` }),
      );
      expect(JSON.stringify(report)).not.toContain(secret);
    });
  });
});

describe('runDoctor hardening', () => {
  it('reports a timed-out command readably, not hidden by an earlier error event', async () => {
    const ref: { emit?: (e: Error) => void } = {};
    const { client, emitError } = fakeRedis({
      ping: async () => {
        ref.emit?.(new Error('some earlier error'));
        throw new Error('Command timed out');
      },
    });
    ref.emit = emitError;
    const report = await runDoctor(makeDeps(client));
    expect(byId(report, 'ping')).toMatchObject({
      status: 'fail',
      message: 'Redis did not respond within 5000ms (command timed out)',
    });
    expect(byId(report, 'server').status).toBe('skip');
    expect(byId(report, 'queues').status).toBe('skip');
  });

  it('turns a synchronous createClient throw into a ping fail with later checks skipped', async () => {
    const report = await runDoctor(
      makeDeps({} as Redis, {
        createClient: () => {
          throw new Error('boom redis://u:pw0rd@h:6379');
        },
      }),
    );
    expect(byId(report, 'ping').status).toBe('fail');
    expect(byId(report, 'ping').message).not.toContain('pw0rd');
    expect(byId(report, 'server').status).toBe('skip');
    expect(byId(report, 'queues').status).toBe('skip');
  });

  it('warns about a non-redis scheme but still diagnoses', async () => {
    const { client } = fakeRedis();
    const report = await runDoctor(makeDeps(client, { redisFlag: 'http://localhost:6379' }));
    expect(byId(report, 'connection').status).toBe('warn');
    expect(byId(report, 'connection').hint).toContain('redis://host:6379');
    expect(byId(report, 'ping').status).toBe('ok');
    expect(doctorExitCode(report)).toBe(0);
  });

  it('warns about a missing scheme and parses the DB like ioredis does', async () => {
    const { client } = fakeRedis();
    const report = await runDoctor(makeDeps(client, { redisFlag: 'localhost:6379/2' }));
    const conn = byId(report, 'connection');
    expect(conn.status).toBe('warn');
    expect(conn.message).toContain('DB 2');
    expect(conn.hint).toContain('Missing scheme');
  });

  it('does not warn for rediss://', async () => {
    const { client } = fakeRedis();
    const report = await runDoctor(makeDeps(client, { redisFlag: 'rediss://h:6380' }));
    expect(byId(report, 'connection').status).toBe('ok');
  });

  describe('connection errors reported only via the error event (PING still succeeds)', () => {
    const cases = [
      [
        'WRONGPASS invalid username-password pair',
        'Redis rejected the credentials. Check the username/password in the URL (or ?password=).',
      ],
      [
        'ERR DB index is out of range',
        "The database number in the URL doesn't exist on this server.",
      ],
    ];
    for (const [msg, hint] of cases) {
      it(`fails ping for ${msg.split(' ')[0]} and skips later checks`, async () => {
        const ref: { emit?: (e: Error) => void } = {};
        const { client, emitError } = fakeRedis({
          ping: async () => {
            ref.emit?.(new Error(msg));
            return 'PONG';
          },
        });
        ref.emit = emitError;
        const report = await runDoctor(makeDeps(client));
        expect(byId(report, 'ping')).toMatchObject({ status: 'fail', message: msg, hint });
        expect(byId(report, 'ping').message).not.toContain('PONG');
        expect(byId(report, 'server').status).toBe('skip');
        expect(byId(report, 'queues').status).toBe('skip');
        expect(doctorExitCode(report)).toBe(1);
      });
    }
  });

  describe('auth-specific ping hint', () => {
    const authMessages = [
      'WRONGPASS invalid username-password pair',
      'NOAUTH Authentication required.',
      'ERR invalid password',
    ];
    for (const msg of authMessages) {
      it(`uses the credentials hint for ${msg.split(' ')[0]}`, async () => {
        const { client } = fakeRedis({
          ping: async () => {
            throw new Error(msg);
          },
        });
        const report = await runDoctor(makeDeps(client));
        expect(byId(report, 'ping').hint).toBe(
          'Redis rejected the credentials. Check the username/password in the URL (or ?password=).',
        );
      });
    }

    it('keeps the generic hint for other failures', async () => {
      const { client } = fakeRedis({
        connect: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:1');
        },
      });
      const report = await runDoctor(makeDeps(client));
      expect(byId(report, 'ping').hint).toBe('Is Redis running and reachable at this URL?');
    });
  });

  it('does not claim "found anywhere" when the candidate cap was hit with no matches', async () => {
    const keys = Array.from({ length: 2500 }, (_, i) => `n${i}:x:meta`);
    const { client } = fakeRedis({ scan: metaScan(keys), metaValid: () => false });
    const report = await runDoctor(makeDeps(client));
    expect(byId(report, 'queues').hint).toBe(
      'Checked the first 2000 *:meta keys and found no BullMQ queues.',
    );
  });

  describe('prefix heuristic only counts real BullMQ meta hashes', () => {
    it('names the real prefix even when noise keys outnumber it', async () => {
      const noise = Array.from({ length: 50 }, (_, i) => `user:${i}:meta`);
      const { client } = fakeRedis({
        scan: metaScan([...noise, 'myapp:a:meta', 'myapp:b:meta']),
        metaValid: (key) => key.startsWith('myapp:'),
      });
      const report = await runDoctor(makeDeps(client));
      expect(byId(report, 'queues').hint).toBe(
        'Queues exist under prefix "myapp" (2). Try --prefix myapp.',
      );
    });

    it('says nothing is found when only noise keys exist', async () => {
      const { client } = fakeRedis({
        scan: metaScan(['user:1:meta', 'cache:page:meta']),
        metaValid: () => false,
      });
      const report = await runDoctor(makeDeps(client));
      expect(byId(report, 'queues').hint).toBe(
        'No BullMQ keys found anywhere. Is this the right Redis instance?',
      );
    });

    it('treats a HEXISTS error (WRONGTYPE) as noise', async () => {
      const { client } = fakeRedis({
        scan: metaScan(['a:x:meta']),
        pipelineResults: [[new Error('WRONGTYPE'), 0]],
      });
      // discovery ignores non-"bull:" keys; the hint pipeline gets the error tuple
      const report = await runDoctor(makeDeps(client));
      expect(byId(report, 'queues').hint).toContain('No BullMQ keys found anywhere');
    });

    it('treats a missing pipeline result as noise', async () => {
      const { client } = fakeRedis({
        scan: metaScan(['a:x:meta']),
        pipelineResults: [],
      });
      const report = await runDoctor(makeDeps(client));
      expect(byId(report, 'queues').hint).toContain('No BullMQ keys found anywhere');
    });

    it('caps how many candidate keys are verified', async () => {
      const keys = Array.from({ length: 2500 }, (_, i) => `n${i}:x:meta`);
      let checkedKeys = 0;
      const { client } = fakeRedis({
        scan: metaScan(keys),
        metaValid: () => {
          checkedKeys += 1;
          return false;
        },
      });
      await runDoctor(makeDeps(client));
      expect(checkedKeys).toBe(2000);
    });

    it('stops scanning once the cap is reached', async () => {
      let scans = 0;
      const { client } = fakeRedis({
        scan: async () => {
          scans += 1;
          const batch = Array.from({ length: 1500 }, (_, i) => `p${scans}${i}:x:meta`);
          return scans === 1 ? ['0', []] : ['9', batch]; // 1st = discovery
        },
        metaValid: () => false,
      });
      await runDoctor(makeDeps(client));
      expect(scans).toBe(3); // discovery + two hint batches (1500 + 500 checked)
    });
  });

  describe('credential masking of scheme-less and query-string URLs', () => {
    const cases = [
      ':topsecret@myhost:6379',
      'user:topsecret@myhost:6379',
      'redis://myhost:6379?password=topsecret',
    ];
    for (const flag of cases) {
      it(`never prints the password for ${flag.replace('topsecret', '***')}`, async () => {
        const { client } = fakeRedis();
        const report = await runDoctor(makeDeps(client, { redisFlag: flag }));
        expect(JSON.stringify(report, null, 2)).not.toContain('topsecret');
        expect(formatDoctorReport(report)).not.toContain('topsecret');
      });
    }

    it('also holds when the connection fails', async () => {
      const report = await runDoctor(
        makeDeps({} as Redis, { redisFlag: 'user:topsecret@myhost:6379/abc' }),
      );
      expect(JSON.stringify(report)).not.toContain('topsecret');
      expect(formatDoctorReport(report)).not.toContain('topsecret');
    });
  });
});

describe('runDoctor JSON output shape', () => {
  it('serialises to { version, checks: [{ id, status, message, hint? }], summary }', async () => {
    const { client } = fakeRedis();
    const report = await runDoctor(makeDeps(client));
    const parsed = JSON.parse(JSON.stringify(report, null, 2));
    expect(Object.keys(parsed)).toEqual(['version', 'checks', 'summary']);
    expect(parsed.version).toBe('1.2.3');
    expect(Object.keys(parsed.summary)).toEqual(['ok', 'warn', 'fail', 'skip']);
    const queues = parsed.checks.find((c: { id: string }) => c.id === 'queues');
    expect(Object.keys(queues).sort()).toEqual(['hint', 'id', 'message', 'status']);
    for (const check of parsed.checks) {
      expect(typeof check.id).toBe('string');
      expect(['ok', 'warn', 'fail', 'skip']).toContain(check.status);
      expect(typeof check.message).toBe('string');
      expect(Object.keys(check).every((k) => ['id', 'status', 'message', 'hint'].includes(k))).toBe(
        true,
      );
    }
  });
});

describe('formatDoctorReport / doctorExitCode', () => {
  const report = {
    version: '0.1.2',
    checks: [
      { id: 'config', status: 'ok' as const, message: 'No config files (using defaults)' },
      {
        id: 'connection',
        status: 'ok' as const,
        message: 'redis://localhost:6379 (default), DB 0, prefix "bull" (default)',
      },
      { id: 'ping', status: 'ok' as const, message: 'PONG in 2ms' },
      { id: 'server', status: 'ok' as const, message: 'Redis 7.2.4 (standalone)' },
      {
        id: 'queues',
        status: 'warn' as const,
        message: 'No queues under prefix "bull"',
        hint: 'Queues exist under prefix "myapp" (3). Try --prefix myapp.',
      },
    ],
    summary: { ok: 4, warn: 1, fail: 0, skip: 0 },
  };

  it('matches the specified layout', () => {
    expect(formatDoctorReport(report)).toBe(
      [
        'bull-cli v0.1.2 — doctor',
        '',
        '✓ config      No config files (using defaults)',
        '✓ connection  redis://localhost:6379 (default), DB 0, prefix "bull" (default)',
        '✓ ping        PONG in 2ms',
        '✓ server      Redis 7.2.4 (standalone)',
        '! queues      No queues under prefix "bull"',
        '              hint: Queues exist under prefix "myapp" (3). Try --prefix myapp.',
        '',
        '4 ok, 1 warning, 0 failed, 0 skipped',
      ].join('\n'),
    );
  });

  it('uses fail/skip symbols and pluralises warnings', () => {
    const text = formatDoctorReport({
      version: '1',
      checks: [
        { id: 'ping', status: 'fail', message: 'x' },
        { id: 'server', status: 'skip', message: 'y' },
      ],
      summary: { ok: 0, warn: 2, fail: 1, skip: 1 },
    });
    expect(text).toContain('✗ ping');
    expect(text).toContain('- server');
    expect(text).toContain('0 ok, 2 warnings, 1 failed, 1 skipped');
  });

  it('formats an empty report', () => {
    expect(
      formatDoctorReport({
        version: '1',
        checks: [],
        summary: { ok: 0, warn: 0, fail: 0, skip: 0 },
      }),
    ).toContain('0 ok');
  });

  it('exit code is 0 for warnings, 1 for failures', () => {
    expect(doctorExitCode(report)).toBe(0);
    expect(doctorExitCode({ ...report, summary: { ...report.summary, fail: 1 } })).toBe(1);
  });

  it('JSON shape is { version, checks, summary }', () => {
    const parsed = JSON.parse(JSON.stringify(report, null, 2));
    expect(Object.keys(parsed)).toEqual(['version', 'checks', 'summary']);
    expect(parsed.checks[4].hint).toContain('--prefix myapp');
  });
});

describe('runDoctor masking of scheme-less and query-string secrets', () => {
  const secret = 'leakme42';
  const shapes = [
    { flag: `:${secret}@myhost:6379`, expected: ':****@myhost:6379' },
    { flag: `user:${secret}@myhost:6379`, expected: 'user:****@myhost:6379' },
    { flag: `redis://myhost:6379?password=${secret}`, expected: 'password=****' },
  ];

  for (const { flag, expected } of shapes) {
    it(`never prints the secret for ${flag.replace(secret, '<secret>')}`, async () => {
      const { client } = fakeRedis();
      const report = await runDoctor(makeDeps(client, { redisFlag: flag }));
      expect(JSON.stringify(report, null, 2)).not.toContain(secret);
      expect(formatDoctorReport(report)).not.toContain(secret);
      expect(JSON.stringify(report)).toContain(expected);
    });
  }
});

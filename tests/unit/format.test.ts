import { describe, expect, it } from 'vitest';
import {
  attemptsLimit,
  classifyStack,
  displayTimestamp,
  formatClock,
  formatDuration,
  formatEvery,
  formatIterations,
  formatRelativeNext,
  formatSchedule,
  jobTimings,
  maskRedisUrl,
  normalizeProgress,
  statusForState,
  withRedisDb,
} from '../../src/core/format.js';

describe('normalizeProgress', () => {
  it('passes through a number within range', () => {
    expect(normalizeProgress(42)).toBe(42);
  });

  it('clamps a negative number to 0', () => {
    expect(normalizeProgress(-10)).toBe(0);
  });

  it('clamps a number above 100 to 100', () => {
    expect(normalizeProgress(150)).toBe(100);
  });

  it('returns null for an object', () => {
    expect(normalizeProgress({ percent: 50 })).toBeNull();
  });

  it('returns null for a string', () => {
    expect(normalizeProgress('50')).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(normalizeProgress(undefined)).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(normalizeProgress(Number.NaN)).toBeNull();
  });

  it('passes through the boundary values 0 and 100 unchanged', () => {
    expect(normalizeProgress(0)).toBe(0);
    expect(normalizeProgress(100)).toBe(100);
  });
});

describe('displayTimestamp', () => {
  const timestamp = 1000;
  const processedOn = 2000;
  const finishedOn = 3000;

  it('completed: prefers finishedOn', () => {
    expect(displayTimestamp({ timestamp, processedOn, finishedOn }, 'completed')).toBe(finishedOn);
  });

  it('completed: falls back to processedOn when finishedOn is absent', () => {
    expect(displayTimestamp({ timestamp, processedOn }, 'completed')).toBe(processedOn);
  });

  it('completed: falls back to timestamp when both finishedOn and processedOn are absent', () => {
    expect(displayTimestamp({ timestamp }, 'completed')).toBe(timestamp);
  });

  it('completed: falls back to 0 when everything is absent', () => {
    expect(displayTimestamp({}, 'completed')).toBe(0);
  });

  it('failed: prefers finishedOn', () => {
    expect(displayTimestamp({ timestamp, processedOn, finishedOn }, 'failed')).toBe(finishedOn);
  });

  it('failed: falls back to processedOn when finishedOn is absent', () => {
    expect(displayTimestamp({ timestamp, processedOn }, 'failed')).toBe(processedOn);
  });

  it('failed: falls back to timestamp when both are absent', () => {
    expect(displayTimestamp({ timestamp }, 'failed')).toBe(timestamp);
  });

  it.each([
    'waiting',
    'active',
    'delayed',
  ] as const)('%s: always uses timestamp, ignoring processedOn/finishedOn', (status) => {
    expect(displayTimestamp({ timestamp, processedOn, finishedOn }, status)).toBe(timestamp);
  });

  it.each([
    'waiting',
    'active',
    'delayed',
  ] as const)('%s: falls back to 0 when timestamp is absent', (status) => {
    expect(displayTimestamp({}, status)).toBe(0);
  });
});

describe('formatClock', () => {
  it('formats a fixed timestamp as YYYY-MM-DD HH:MM:SS in local time', () => {
    const ms = Date.UTC(2026, 6, 5, 14, 3, 21); // 2026-07-05T14:03:21Z
    const date = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    const expected = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
      date.getHours(),
    )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

    expect(formatClock(ms)).toBe(expected);
  });

  it('matches the expected shape', () => {
    expect(formatClock(Date.now())).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('maskRedisUrl', () => {
  it('masks the password when a username is present', () => {
    expect(maskRedisUrl('redis://user:secret@host:6379')).toBe('redis://user:****@host:6379');
  });

  it('masks a password-only URL (no username)', () => {
    expect(maskRedisUrl('redis://:secret@host:6379')).toBe('redis://:****@host:6379');
  });

  it('passes through a URL with no auth unchanged', () => {
    expect(maskRedisUrl('redis://localhost:6379')).toBe('redis://localhost:6379');
  });

  it('does not fabricate a password on a username-only URL', () => {
    expect(maskRedisUrl('redis://user@host:6379')).toBe('redis://user@host:6379');
  });

  it('passes through a URL with a db index and no auth unchanged', () => {
    expect(maskRedisUrl('redis://localhost:6379/2')).toBe('redis://localhost:6379/2');
  });

  it('masks the password on a rediss:// (TLS) URL', () => {
    expect(maskRedisUrl('rediss://user:secret@host:6380')).toBe('rediss://user:****@host:6380');
  });

  it('does not throw on malformed input, returning it unchanged', () => {
    expect(maskRedisUrl('not a url at all')).toBe('not a url at all');
  });

  it('does not throw on an empty string', () => {
    expect(maskRedisUrl('')).toBe('');
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0ms'],
    [340, '340ms'],
    [999, '999ms'],
    [1000, '1.0s'],
    [2140, '2.1s'],
    [59_949, '59.9s'],
    [60_000, '1m 0s'],
    [252_000, '4m 12s'],
    [3_600_000, '1h 0m'],
    [3_900_000, '1h 5m'],
  ])('formats %i ms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('clamps negative durations (worker clock skew) to 0ms', () => {
    expect(formatDuration(-50)).toBe('0ms');
  });
});

describe('jobTimings', () => {
  it('has neither value for a job that has not been processed', () => {
    expect(jobTimings({ created: 0, processed: null, finished: null })).toEqual({
      waited: null,
      ran: null,
    });
  });

  it('has only the wait for a job still running', () => {
    expect(jobTimings({ created: 0, processed: 2100, finished: null })).toEqual({
      waited: '2.1s',
      ran: null,
    });
  });

  it('has the wait and the run time for a finished job', () => {
    expect(jobTimings({ created: 0, processed: 2100, finished: 2440 })).toEqual({
      waited: '2.1s',
      ran: '340ms',
    });
  });
});

describe('attemptsLimit', () => {
  it('reads opts.attempts', () => {
    expect(attemptsLimit({ attempts: 3 })).toBe(3);
  });

  it.each([
    [{}],
    [{ attempts: 0 }],
    [{ attempts: '3' }],
    [null],
    [undefined],
  ])('defaults to a single attempt for %j', (opts) => {
    expect(attemptsLimit(opts)).toBe(1);
  });
});

describe('classifyStack', () => {
  const stack = [
    'Error: boom',
    '    at handler (/app/src/worker.ts:10:5)',
    '    at Worker.callProcessJob (/app/node_modules/bullmq/dist/cjs/classes/worker.js:176:21)',
    '    at helper (/app/src/util.ts:3:1)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)',
    '    at node:internal/main:1:1',
  ].join('\n');

  it('tags the message, first own frame, other own frames, and library frames', () => {
    expect(classifyStack([stack]).map((line) => line.kind)).toEqual([
      'message',
      'origin',
      'library',
      'frame',
      'library',
      'library',
    ]);
  });

  it("finds an origin frame in each attempt's stack separately", () => {
    const kinds = classifyStack([stack, stack]).map((line) => line.kind);
    expect(kinds.filter((kind) => kind === 'origin')).toHaveLength(2);
  });

  it('keeps the original line text', () => {
    expect(classifyStack(['Error: x\n    at a (/b.ts:1:1)']).map((line) => line.text)).toEqual([
      'Error: x',
      '    at a (/b.ts:1:1)',
    ]);
  });

  it('has no origin when every frame is a library frame', () => {
    const kinds = classifyStack(['Error: x\n    at f (/app/node_modules/x/index.js:1:1)']).map(
      (line) => line.kind,
    );
    expect(kinds).toEqual(['message', 'library']);
  });
});

describe('statusForState', () => {
  it.each([
    'active',
    'waiting',
    'completed',
    'failed',
    'delayed',
  ] as const)('passes the %s status through', (state) => {
    expect(statusForState(state)).toBe(state);
  });

  it.each(['prioritized', 'waiting-children'])('treats %s as waiting', (state) => {
    expect(statusForState(state)).toBe('waiting');
  });

  it('has no status for an unknown state', () => {
    expect(statusForState('unknown')).toBeUndefined();
  });
});

describe('formatEvery', () => {
  it.each([
    [0, '0ms'],
    [500, '500ms'],
    [1500, '1s 500ms'],
    [30_000, '30s'],
    [300_000, '5m'],
    [90_000, '1m 30s'],
    [5_400_000, '1h 30m'],
    [3_600_000, '1h'],
    [93_784_000, '1d 2h'],
    [-5, '0ms'],
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatEvery(ms)).toBe(expected);
  });
});

describe('formatSchedule', () => {
  it('prefers the cron pattern', () => {
    expect(formatSchedule({ pattern: '0 9 * * *', every: null })).toBe('0 9 * * *');
  });

  it('describes an every scheduler', () => {
    expect(formatSchedule({ pattern: null, every: 300_000 })).toBe('every 5m');
    expect(formatSchedule({ pattern: null, every: 30_000 })).toBe('every 30s');
  });

  it('falls back to a dash', () => {
    expect(formatSchedule({ pattern: null, every: null })).toBe('—');
  });
});

describe('formatRelativeNext', () => {
  const now = 1_000_000;

  it.each([
    [now + 45_000, 'in 45s'],
    [now + 500, 'in 1s'],
    [now, 'in 0s'],
    [now + 120_000, 'in 2m'],
    [now + 3 * 3_600_000, 'in 3h'],
    [now + 2 * 86_400_000, 'in 2d'],
    [now - 1, 'overdue'],
    [null, '—'],
  ])('formats %s as %s', (target, expected) => {
    expect(formatRelativeNext(target, now)).toBe(expected);
  });
});

describe('formatIterations', () => {
  it('shows the bare count without a limit', () => {
    expect(formatIterations(3, null)).toBe('3');
  });

  it('shows count/limit with a limit', () => {
    expect(formatIterations(3, 24)).toBe('3/24');
  });
});

describe('withRedisDb', () => {
  it('sets or replaces the DB path', () => {
    expect(withRedisDb('redis://localhost:6379', 1)).toBe('redis://localhost:6379/1');
    expect(withRedisDb('redis://localhost:6379/5', 0)).toBe('redis://localhost:6379/0');
    expect(withRedisDb('redis://user:****@host:6379', 2)).toBe('redis://user:****@host:6379/2');
  });

  it('returns unparseable input unchanged', () => {
    expect(withRedisDb('nope', 1)).toBe('nope');
  });
});

describe('maskRedisUrl on URLs that fail to parse', () => {
  it('masks user:password userinfo', () => {
    expect(maskRedisUrl('redis://user:pw@[::1')).toBe('redis://user:****@[::1');
    expect(maskRedisUrl('redis://user:pw@h:bad')).toBe('redis://user:****@h:bad');
  });

  it('masks a password-only userinfo', () => {
    expect(maskRedisUrl('redis://:pw@[::1')).toBe('redis://:****@[::1');
  });

  it('masks a bare userinfo with no colon', () => {
    expect(maskRedisUrl('redis://pw@[::1')).toBe('redis://****@[::1');
  });

  it('masks up to the last @ so an @ inside the password cannot leak', () => {
    expect(maskRedisUrl('redis://user:p@ss@[::1')).toBe('redis://user:****@[::1');
  });

  it('leaves unparseable URLs without credentials unchanged', () => {
    expect(maskRedisUrl('redis://[::1')).toBe('redis://[::1');
    expect(maskRedisUrl('not a url')).toBe('not a url');
  });
});

describe('maskRedisUrl: scheme-less, foreign-scheme and query-string credentials', () => {
  it('masks scheme-less userinfo (ioredis prepends redis:// to these)', () => {
    expect(maskRedisUrl(':secret@host:6379')).toBe(':****@host:6379');
    expect(maskRedisUrl('user:secret@host:6379')).toBe('user:****@host:6379');
    expect(maskRedisUrl('secret@host:6379')).toBe('****@host:6379');
  });

  it('masks userinfo on non-redis schemes', () => {
    expect(maskRedisUrl('http://u:secret@host:6379')).toBe('http://u:****@host:6379');
  });

  it('masks password/username query parameters', () => {
    expect(maskRedisUrl('redis://host:6379?password=secret')).toBe(
      'redis://host:6379?password=****',
    );
    expect(maskRedisUrl('redis://host:6379/2?db=1&username=bob&password=s3')).toBe(
      'redis://host:6379/2?db=1&username=****&password=****',
    );
    expect(maskRedisUrl('http://host?password=secret#x')).toBe('http://host?password=****#x');
    expect(maskRedisUrl('host:6379?password=secret')).not.toContain('secret');
  });

  it('masks both userinfo and query parameter together', () => {
    const masked = maskRedisUrl('redis://u:one@host:6379?password=two');
    expect(masked).not.toContain('one');
    expect(masked).not.toContain('two');
  });

  it('leaves clean redis URLs byte-for-byte unchanged', () => {
    expect(maskRedisUrl('redis://localhost:6379')).toBe('redis://localhost:6379');
    expect(maskRedisUrl('rediss://host:6380/2?family=6')).toBe('rediss://host:6380/2?family=6');
  });
});

describe('maskRedisUrl: sentinelPassword', () => {
  it('masks it in parsed and fallback paths', () => {
    expect(maskRedisUrl('redis://host:6379?sentinelPassword=secret')).toBe(
      'redis://host:6379?sentinelPassword=****',
    );
    expect(maskRedisUrl('host:6379?sentinelPassword=secret')).toBe(
      'host:6379?sentinelPassword=****',
    );
  });
});

import { describe, expect, it } from 'vitest';
import {
  displayTimestamp,
  formatClock,
  maskRedisUrl,
  normalizeProgress,
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

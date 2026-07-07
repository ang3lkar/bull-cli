import { describe, expect, it } from 'vitest';
import { resolvePrefix, resolveRedisUrl } from '../../src/config.js';

describe('resolveRedisUrl', () => {
  it('prefers the flag over env and default', () => {
    const env = { REDIS_URL: 'redis://env-host:6379' };
    expect(resolveRedisUrl('redis://flag-host:6379', env)).toBe('redis://flag-host:6379');
  });

  it('falls back to REDIS_URL when no flag is given', () => {
    const env = { REDIS_URL: 'redis://env-host:6379' };
    expect(resolveRedisUrl(undefined, env)).toBe('redis://env-host:6379');
  });

  it('falls back to the default when neither flag nor env are set', () => {
    expect(resolveRedisUrl(undefined, {})).toBe('redis://localhost:6379');
  });

  it('uses the flag alone when env is absent', () => {
    expect(resolveRedisUrl('redis://flag-only:6379', {})).toBe('redis://flag-only:6379');
  });

  it('uses env alone when no flag is given', () => {
    expect(resolveRedisUrl(undefined, { REDIS_URL: 'redis://env-only:6379' })).toBe(
      'redis://env-only:6379',
    );
  });

  it('treats an empty-string flag as absent, falling through to env', () => {
    expect(resolveRedisUrl('', { REDIS_URL: 'redis://env-host:6379' })).toBe(
      'redis://env-host:6379',
    );
  });

  it('treats a whitespace-only flag as absent', () => {
    expect(resolveRedisUrl('   ', {})).toBe('redis://localhost:6379');
  });

  it('falls through a whitespace-only flag to a present env value', () => {
    expect(resolveRedisUrl('   ', { REDIS_URL: 'redis://env-host:6379' })).toBe(
      'redis://env-host:6379',
    );
  });

  it('treats a whitespace-only REDIS_URL env var as absent', () => {
    expect(resolveRedisUrl(undefined, { REDIS_URL: '   ' })).toBe('redis://localhost:6379');
  });

  it('treats an empty-string REDIS_URL env var as absent', () => {
    expect(resolveRedisUrl(undefined, { REDIS_URL: '' })).toBe('redis://localhost:6379');
  });

  it('passes through a password-only auth URL untouched', () => {
    const url = 'redis://:pass@host:6379';
    expect(resolveRedisUrl(url, {})).toBe(url);
  });

  it('passes through a username+password auth URL untouched', () => {
    const url = 'redis://user:pass@host:6379';
    expect(resolveRedisUrl(url, {})).toBe(url);
  });

  it('preserves a URL with a db path segment', () => {
    const url = 'redis://host:6379/3';
    expect(resolveRedisUrl(url, {})).toBe(url);
  });

  it('preserves an auth URL with a db path segment coming from env', () => {
    const url = 'redis://user:pass@host:6379/2';
    expect(resolveRedisUrl(undefined, { REDIS_URL: url })).toBe(url);
  });
});

describe('resolvePrefix', () => {
  it('prefers the flag over env and default', () => {
    const env = { BULLMQ_PREFIX: 'env-prefix' };
    expect(resolvePrefix('flag-prefix', env)).toBe('flag-prefix');
  });

  it('falls back to BULLMQ_PREFIX when no flag is given', () => {
    const env = { BULLMQ_PREFIX: 'env-prefix' };
    expect(resolvePrefix(undefined, env)).toBe('env-prefix');
  });

  it('falls back to the default when neither flag nor env are set', () => {
    expect(resolvePrefix(undefined, {})).toBe('bull');
  });

  it('uses the flag alone when env is absent', () => {
    expect(resolvePrefix('flag-only', {})).toBe('flag-only');
  });

  it('uses env alone when no flag is given', () => {
    expect(resolvePrefix(undefined, { BULLMQ_PREFIX: 'env-only' })).toBe('env-only');
  });

  it('treats an empty-string flag as absent, falling through to env', () => {
    expect(resolvePrefix('', { BULLMQ_PREFIX: 'env-prefix' })).toBe('env-prefix');
  });

  it('treats a whitespace-only flag as absent', () => {
    expect(resolvePrefix('   ', {})).toBe('bull');
  });

  it('falls through a whitespace-only flag to a present env value', () => {
    expect(resolvePrefix('   ', { BULLMQ_PREFIX: 'env-prefix' })).toBe('env-prefix');
  });

  it('treats a whitespace-only BULLMQ_PREFIX env var as absent', () => {
    expect(resolvePrefix(undefined, { BULLMQ_PREFIX: '   ' })).toBe('bull');
  });

  it('treats an empty-string BULLMQ_PREFIX env var as absent', () => {
    expect(resolvePrefix(undefined, { BULLMQ_PREFIX: '' })).toBe('bull');
  });
});

import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  parseConfigFile,
  projectConfigPath,
  resolvePrefix,
  resolveRedisUrl,
  resolveRefreshIntervalMs,
  userConfigPath,
} from '../../src/config.js';

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

describe('userConfigPath', () => {
  it('uses XDG_CONFIG_HOME when set', () => {
    expect(userConfigPath({ XDG_CONFIG_HOME: '/custom/config' }, '/home/user')).toBe(
      '/custom/config/bull-cli/config.json',
    );
  });

  it('falls back to <home>/.config when XDG_CONFIG_HOME is unset', () => {
    expect(userConfigPath({}, '/home/user')).toBe('/home/user/.config/bull-cli/config.json');
  });

  it('treats a whitespace-only XDG_CONFIG_HOME as absent', () => {
    expect(userConfigPath({ XDG_CONFIG_HOME: '   ' }, '/home/user')).toBe(
      '/home/user/.config/bull-cli/config.json',
    );
  });
});

describe('projectConfigPath', () => {
  it('joins bull-cli.json onto the given cwd', () => {
    expect(projectConfigPath('/repo/project')).toBe('/repo/project/bull-cli.json');
  });
});

describe('parseConfigFile', () => {
  it('parses an empty object', () => {
    expect(parseConfigFile('{}', 'config.json')).toEqual({});
  });

  it('parses a valid refreshIntervalMs', () => {
    expect(parseConfigFile('{"refreshIntervalMs": 5000}', 'config.json')).toEqual({
      refreshIntervalMs: 5000,
    });
  });

  it('supports line and block comments (JSONC)', () => {
    const source = `{
      // how often to poll
      "refreshIntervalMs": 5000 /* ms */
    }`;
    expect(parseConfigFile(source, 'config.json')).toEqual({ refreshIntervalMs: 5000 });
  });

  it('supports a trailing comma', () => {
    expect(parseConfigFile('{"refreshIntervalMs": 5000,}', 'config.json')).toEqual({
      refreshIntervalMs: 5000,
    });
  });

  it('throws ConfigError with the file path on a syntax error', () => {
    expect(() => parseConfigFile('{not valid json', 'bad.json')).toThrow(ConfigError);
    expect(() => parseConfigFile('{not valid json', 'bad.json')).toThrow(/bad\.json/);
  });

  it('throws when the top level is not an object', () => {
    expect(() => parseConfigFile('[1, 2, 3]', 'config.json')).toThrow(ConfigError);
    expect(() => parseConfigFile('"just a string"', 'config.json')).toThrow(ConfigError);
  });

  it('throws on an unknown key', () => {
    expect(() => parseConfigFile('{"pollFrequency": 5000}', 'config.json')).toThrow(
      /unknown config key "pollFrequency"/,
    );
  });

  it('suggests the correct key for a near-miss typo', () => {
    expect(() => parseConfigFile('{"refreshIntervalMS": 5000}', 'config.json')).toThrow(
      /did you mean "refreshIntervalMs"/,
    );
  });

  it('omits a suggestion when nothing is close enough', () => {
    expect(() => parseConfigFile('{"totallyUnrelatedSetting": 1}', 'config.json')).toThrow(
      /unknown config key "totallyUnrelatedSetting"$/,
    );
  });

  it('throws when refreshIntervalMs is not a number', () => {
    expect(() => parseConfigFile('{"refreshIntervalMs": "3000"}', 'config.json')).toThrow(
      /must be an integer/,
    );
  });

  it('throws when refreshIntervalMs is not an integer', () => {
    expect(() => parseConfigFile('{"refreshIntervalMs": 3000.5}', 'config.json')).toThrow(
      /must be an integer/,
    );
  });

  it('throws when refreshIntervalMs is below the floor, with a seconds hint', () => {
    expect(() => parseConfigFile('{"refreshIntervalMs": 3}', 'config.json')).toThrow(
      /must be >= 250, got: 3 — did you mean 3000 \(3 seconds\)\?/,
    );
  });

  it('throws when refreshIntervalMs is negative, without a seconds hint', () => {
    expect(() => parseConfigFile('{"refreshIntervalMs": -100}', 'config.json')).toThrow(
      /must be >= 250, got: -100$/,
    );
  });

  it('accepts exactly the floor value', () => {
    expect(parseConfigFile('{"refreshIntervalMs": 250}', 'config.json')).toEqual({
      refreshIntervalMs: 250,
    });
  });
});

describe('resolveRefreshIntervalMs', () => {
  it('defaults to 3000 when neither config is present', () => {
    expect(resolveRefreshIntervalMs(null, null)).toBe(3000);
  });

  it('uses the user config when only it is present', () => {
    expect(resolveRefreshIntervalMs({ refreshIntervalMs: 5000 }, null)).toBe(5000);
  });

  it('uses the project config when only it is present', () => {
    expect(resolveRefreshIntervalMs(null, { refreshIntervalMs: 1000 })).toBe(1000);
  });

  it('prefers the project config over the user config', () => {
    expect(resolveRefreshIntervalMs({ refreshIntervalMs: 5000 }, { refreshIntervalMs: 1000 })).toBe(
      1000,
    );
  });

  it('falls back to the default when both configs are present but neither sets the key', () => {
    expect(resolveRefreshIntervalMs({}, {})).toBe(3000);
  });
});

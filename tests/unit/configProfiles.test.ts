// biome-ignore-all lint/suspicious/noTemplateCurlyInString: config values are literally `${VAR}`.
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  parseConfigFile,
  prefixSource,
  redisUrlSource,
  resolvePrefix,
  resolveRedisUrl,
  type SelectedProfile,
  selectProfile,
  type UserConfig,
} from '../../src/config.js';

const FILE = '/tmp/bull-cli.json';
const parse = (source: string) => parseConfigFile(source, FILE);
const parseError = (source: string) => {
  try {
    parse(source);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('expected a ConfigError');
};

const profile = (p: Partial<SelectedProfile> = {}): SelectedProfile => ({
  name: 'staging',
  redisUrl: 'redis://staging:6379',
  ...p,
});

describe('parseConfigFile: profiles', () => {
  it('parses profiles and defaultProfile alongside the other keys (JSONC)', () => {
    const config = parse(`{
      // connections
      "defaultProfile": "local",
      "profiles": {
        "local": { "redisUrl": "redis://localhost:6379" },
        "prod": { "redisUrl": "\${PROD_REDIS_URL}", "prefix": "myapp", },
      },
      "refreshIntervalMs": 1000,
    }`);
    expect(config).toEqual({
      defaultProfile: 'local',
      profiles: {
        local: { redisUrl: 'redis://localhost:6379' },
        prod: { redisUrl: '${PROD_REDIS_URL}', prefix: 'myapp' },
      },
      refreshIntervalMs: 1000,
    });
  });

  it('accepts an empty profiles object', () => {
    expect(parse('{ "profiles": {} }')).toEqual({ profiles: {} });
  });

  it('suggests "profiles" for a mistyped top-level key', () => {
    expect(parseError('{ "profile": {} }')).toBe(
      `${FILE}: unknown config key "profile" — did you mean "profiles"?`,
    );
    expect(parseError('{ "defaultProfle": "x" }')).toContain('did you mean "defaultProfile"?');
  });

  it.each([
    ['[]', '[]'],
    ['null', 'null'],
    ['"local"', '"local"'],
  ])('rejects profiles that is not an object: %s', (value, shown) => {
    expect(parseError(`{ "profiles": ${value} }`)).toBe(
      `${FILE}: "profiles" must be an object of named profiles, got: ${shown}`,
    );
  });

  it.each([
    ['1', '1'],
    ['""', '""'],
    ['"  "', '"  "'],
    ['null', 'null'],
  ])('rejects a defaultProfile that is not a non-empty string: %s', (value, shown) => {
    expect(parseError(`{ "defaultProfile": ${value} }`)).toBe(
      `${FILE}: "defaultProfile" must be a non-empty string, got: ${shown}`,
    );
  });

  it('rejects an empty profile name', () => {
    expect(parseError('{ "profiles": { " ": { "redisUrl": "redis://x" } } }')).toBe(
      `${FILE}: a profile name must not be empty`,
    );
  });

  it('rejects a profile that is not an object', () => {
    expect(parseError('{ "profiles": { "local": "redis://x" } }')).toBe(
      `${FILE}: profile "local" must be an object, got: "redis://x"`,
    );
  });

  it('rejects an unknown key inside a profile, with a suggestion', () => {
    expect(parseError('{ "profiles": { "local": { "redisURL": "redis://x" } } }')).toBe(
      `${FILE}: profile "local": unknown key "redisURL" — did you mean "redisUrl"?`,
    );
    expect(
      parseError('{ "profiles": { "local": { "redisUrl": "redis://x", "zzzzzzzzz": 1 } } }'),
    ).toBe(`${FILE}: profile "local": unknown key "zzzzzzzzz"`);
  });

  it.each([
    ['{}', 'undefined'],
    ['{ "redisUrl": "" }', '""'],
    ['{ "redisUrl": 6379 }', '6379'],
  ])('requires a non-empty string redisUrl: %s', (body, shown) => {
    expect(parseError(`{ "profiles": { "local": ${body} } }`)).toBe(
      `${FILE}: profile "local": "redisUrl" is required and must be a non-empty string, got: ${shown}`,
    );
  });

  it.each([
    ['""', '""'],
    ['1', '1'],
  ])('rejects a prefix that is not a non-empty string: %s', (value, shown) => {
    expect(
      parseError(`{ "profiles": { "local": { "redisUrl": "redis://x", "prefix": ${value} } } }`),
    ).toBe(`${FILE}: profile "local": "prefix" must be a non-empty string, got: ${shown}`);
  });
});

describe('selectProfile', () => {
  const user: UserConfig = {
    defaultProfile: 'local',
    profiles: {
      local: { redisUrl: 'redis://localhost:6379' },
      staging: { redisUrl: 'redis://user-staging:6379', prefix: 'userprefix' },
    },
  };

  it('returns null with no flag and no defaultProfile', () => {
    expect(selectProfile(undefined, null, null)).toBeNull();
    expect(selectProfile(undefined, { profiles: user.profiles }, null)).toBeNull();
  });

  it('uses defaultProfile when there is no flag', () => {
    expect(selectProfile(undefined, user, null)).toEqual({
      name: 'local',
      redisUrl: 'redis://localhost:6379',
    });
  });

  it('prefers --profile over defaultProfile', () => {
    expect(selectProfile('staging', user, null)?.name).toBe('staging');
  });

  it('treats an empty --profile as absent', () => {
    expect(selectProfile('  ', user, null)?.name).toBe('local');
  });

  it("lets the project file's defaultProfile win", () => {
    expect(selectProfile(undefined, user, { defaultProfile: 'staging' })?.name).toBe('staging');
  });

  it('lets a project defaultProfile name a profile defined only in the user file', () => {
    const project: UserConfig = {
      defaultProfile: 'staging',
      profiles: { other: { redisUrl: 'redis://o' } },
    };
    expect(selectProfile(undefined, user, project)).toEqual({
      name: 'staging',
      redisUrl: 'redis://user-staging:6379',
      prefix: 'userprefix',
    });
  });

  it('replaces a same-named user profile as a whole (no field merge)', () => {
    const project: UserConfig = { profiles: { staging: { redisUrl: 'redis://proj-staging' } } };
    expect(selectProfile('staging', user, project)).toEqual({
      name: 'staging',
      redisUrl: 'redis://proj-staging',
    });
  });

  it('rejects an unknown --profile, listing the available profiles sorted', () => {
    expect(() => selectProfile('prod', user, { profiles: { alpha: { redisUrl: 'r' } } })).toThrow(
      new ConfigError('Unknown profile "prod": available profiles: alpha, local, staging'),
    );
  });

  it('suggests a close profile name', () => {
    expect(() => selectProfile('stagin', user, null)).toThrow(
      'Unknown profile "stagin": available profiles: local, staging; did you mean "staging"?',
    );
  });

  it('says so when no profiles are defined at all', () => {
    expect(() => selectProfile('prod', null, null)).toThrow(
      'Unknown profile "prod": no profiles are defined in the config files',
    );
  });

  it('rejects a defaultProfile that names a missing profile, saying where it came from', () => {
    expect(() => selectProfile(undefined, { ...user, defaultProfile: 'gone' }, null)).toThrow(
      'Unknown profile "gone" (set by "defaultProfile"): available profiles: local, staging',
    );
  });

  it("doesn't treat Object prototype keys as profiles", () => {
    expect(() => selectProfile('toString', user, null)).toThrow('Unknown profile "toString"');
  });
});

describe('precedence: flag > env > profile > default', () => {
  const env = { REDIS_URL: 'redis://env:6379', BULLMQ_PREFIX: 'envprefix' };
  const p = profile({ prefix: 'profprefix' });

  it('redis URL', () => {
    expect(resolveRedisUrl('redis://flag', env, p)).toBe('redis://flag');
    expect(resolveRedisUrl(undefined, env, p)).toBe('redis://env:6379');
    expect(resolveRedisUrl(undefined, {}, p)).toBe('redis://staging:6379');
    expect(resolveRedisUrl(undefined, {}, null)).toBe('redis://localhost:6379');
    expect(resolveRedisUrl(undefined, { REDIS_URL: ' ' }, p)).toBe('redis://staging:6379');
  });

  it('prefix', () => {
    expect(resolvePrefix('flagprefix', env, p)).toBe('flagprefix');
    expect(resolvePrefix(undefined, env, p)).toBe('envprefix');
    expect(resolvePrefix(undefined, {}, p)).toBe('profprefix');
    expect(resolvePrefix(undefined, {}, profile())).toBe('bull');
    expect(resolvePrefix(undefined, {}, null)).toBe('bull');
  });

  it('reports which source each value came from', () => {
    expect(redisUrlSource('redis://flag', env, p)).toBe('flag');
    expect(redisUrlSource(undefined, env, p)).toBe('env');
    expect(redisUrlSource(undefined, {}, p)).toBe('profile');
    expect(redisUrlSource(undefined, {}, null)).toBe('default');
    expect(prefixSource('x', env, p)).toBe('flag');
    expect(prefixSource(undefined, env, p)).toBe('env');
    expect(prefixSource(undefined, {}, p)).toBe('profile');
    expect(prefixSource(undefined, {}, profile())).toBe('default');
  });
});

describe('${VAR} interpolation', () => {
  const secret = profile({ name: 'prod', redisUrl: '${PROD_URL}', prefix: '${PROD_PREFIX}' });

  it('reads a value of the exact form ${VAR} from the environment', () => {
    const env = { PROD_URL: 'redis://:s3cret@prod:6379', PROD_PREFIX: 'app' };
    expect(resolveRedisUrl(undefined, env, secret)).toBe('redis://:s3cret@prod:6379');
    expect(resolvePrefix(undefined, env, secret)).toBe('app');
  });

  it('leaves anything that is not exactly ${VAR} as written', () => {
    const env = { HOST: 'h' };
    for (const redisUrl of ['redis://${HOST}:6379', '$HOST', '${HOST', ' ${HOST}', '${1X}']) {
      expect(resolveRedisUrl(undefined, env, profile({ redisUrl }))).toBe(redisUrl);
    }
  });

  it('fails on an unset variable, naming the profile, field and variable', () => {
    expect(() => resolveRedisUrl(undefined, {}, secret)).toThrow(
      new ConfigError('profile "prod": redisUrl uses ${PROD_URL}, which is not set'),
    );
    expect(() => resolvePrefix(undefined, {}, secret)).toThrow(
      'profile "prod": prefix uses ${PROD_PREFIX}, which is not set',
    );
  });

  it('treats an empty or whitespace-only variable as unset', () => {
    expect(() => resolveRedisUrl(undefined, { PROD_URL: '' }, secret)).toThrow('is not set');
    expect(() => resolveRedisUrl(undefined, { PROD_URL: '  ' }, secret)).toThrow('is not set');
  });

  it('only reads the variable when the profile wins, so --redis or REDIS_URL still work', () => {
    expect(resolveRedisUrl('redis://flag', {}, secret)).toBe('redis://flag');
    expect(resolveRedisUrl(undefined, { REDIS_URL: 'redis://env' }, secret)).toBe('redis://env');
    expect(resolvePrefix('p', {}, secret)).toBe('p');
  });
});

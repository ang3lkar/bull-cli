import { join } from 'node:path';
import { type ParseError, parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';

const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const DEFAULT_REDIS_PORT = 6379;
const DEFAULT_REDIS_DB = 0;
export const DEFAULT_BULLMQ_PREFIX = 'bull';
export const DEFAULT_REFRESH_INTERVAL_MS = 3000;
export const DEFAULT_REFRESH_TIMEOUT_MS = 5000;
const MIN_REFRESH_INTERVAL_MS = 250;
const MIN_REFRESH_TIMEOUT_MS = 250;

/** Connection options accepted by both `ioredis` and `bullmq`'s `Queue`/`Worker`. */
export interface ConnectionOpts {
  host: string;
  port: number;
  db: number;
  username?: string;
  password?: string;
  /** Present (as an empty options object) when the URL scheme is `rediss:`. */
  tls?: Record<string, never>;
}

const isSet = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== '';

/** A value of exactly this form is read from the environment variable it names. */
const ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Resolves a profile field: a value of the exact form `${NAME}` is replaced
 * by that environment variable, anything else is used as written (so
 * `redis://${HOST}` stays literal). An unset or empty variable is a
 * `ConfigError` naming the profile, field and variable, never a value.
 */
function interpolate(
  value: string,
  field: keyof ProfileConfig,
  profile: SelectedProfile,
  env: NodeJS.ProcessEnv,
): string {
  const match = ENV_REFERENCE.exec(value);
  if (match === null) {
    return value;
  }
  const resolved = env[match[1]];
  if (!isSet(resolved)) {
    throw new ConfigError(
      `profile "${profile.name}": ${field} uses \${${match[1]}}, which is not set`,
    );
  }
  return resolved;
}

/**
 * Resolves the Redis connection URL using the documented precedence:
 * `--redis` flag > `REDIS_URL` env var > selected profile > default
 * localhost URL.
 *
 * Empty or whitespace-only values (flag or env) are treated as absent. The
 * profile's `${VAR}` reference is only read when the profile is what wins,
 * so `--redis` works even when the default profile's variable isn't set.
 * Throws `ConfigError` for an unset `${VAR}`.
 * Pure function — no I/O, no reliance on process globals (env is injected).
 */
export function resolveRedisUrl(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  profile: SelectedProfile | null = null,
): string {
  if (isSet(flag)) {
    return flag;
  }
  if (isSet(env.REDIS_URL)) {
    return env.REDIS_URL;
  }
  if (profile !== null) {
    return interpolate(profile.redisUrl, 'redisUrl', profile, env);
  }
  return DEFAULT_REDIS_URL;
}

/**
 * Resolves the BullMQ Redis key prefix using the documented precedence:
 * `--prefix` flag > `BULLMQ_PREFIX` env var > selected profile's `prefix` >
 * `'bull'` default (bullmq's own default).
 *
 * Empty or whitespace-only values (flag or env) are treated as absent.
 * Throws `ConfigError` for an unset `${VAR}`.
 * Pure function — no I/O, no reliance on process globals (env is injected).
 */
export function resolvePrefix(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  profile: SelectedProfile | null = null,
): string {
  if (isSet(flag)) {
    return flag;
  }
  if (isSet(env.BULLMQ_PREFIX)) {
    return env.BULLMQ_PREFIX;
  }
  if (profile?.prefix !== undefined) {
    return interpolate(profile.prefix, 'prefix', profile, env);
  }
  return DEFAULT_BULLMQ_PREFIX;
}

export type ConfigSource = 'flag' | 'env' | 'profile' | 'default';

/** Which input `resolveRedisUrl` would pick: the flag, `REDIS_URL`, the profile, or the default. Pure. */
export function redisUrlSource(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  profile: SelectedProfile | null = null,
): ConfigSource {
  if (isSet(flag)) {
    return 'flag';
  }
  if (isSet(env.REDIS_URL)) {
    return 'env';
  }
  return profile !== null ? 'profile' : 'default';
}

/** Which input `resolvePrefix` would pick: the flag, `BULLMQ_PREFIX`, the profile, or the default. Pure. */
export function prefixSource(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  profile: SelectedProfile | null = null,
): ConfigSource {
  if (isSet(flag)) {
    return 'flag';
  }
  if (isSet(env.BULLMQ_PREFIX)) {
    return 'env';
  }
  return profile?.prefix !== undefined ? 'profile' : 'default';
}

/**
 * Parses a `redis[s]://[[username]:password@]host[:port][/db]` URL into the
 * discrete connection options `ioredis`/`bullmq` accept. Pure function — no
 * I/O. Empty username/password segments (e.g. `redis://:pass@host`) are
 * omitted rather than passed through as empty strings.
 *
 * Kept at parity with what `redis.ts` hands ioredis directly (the URL
 * string): a `rediss:` scheme turns on TLS, and an IPv6 host has its
 * brackets stripped — `URL#hostname` keeps them (e.g. `[::1]`), but
 * ioredis/bullmq's `host` option expects the bare address.
 */
export function connectionFromUrl(url: string): ConnectionOpts {
  const parsed = new URL(url);
  const port = parsed.port !== '' ? Number(parsed.port) : DEFAULT_REDIS_PORT;
  const dbSegment = parsed.pathname.replace(/^\//, '');
  const db = dbSegment !== '' ? Number(dbSegment) : DEFAULT_REDIS_DB;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  const opts: ConnectionOpts = {
    host,
    port,
    db,
  };
  if (parsed.username !== '') {
    opts.username = decodeURIComponent(parsed.username);
  }
  if (parsed.password !== '') {
    opts.password = decodeURIComponent(parsed.password);
  }
  if (parsed.protocol === 'rediss:') {
    opts.tls = {};
  }
  return opts;
}

/** Settings the optional JSONC config files may override. Every field is optional — an empty file is valid. */
export interface UserConfig {
  refreshIntervalMs?: number;
  /**
   * How long a single refresh cycle may run before the dashboard abandons
   * it. Worth raising for a Redis instance reached over a high-latency link
   * (a tunnelled/remote instance), where discovery legitimately takes longer
   * than the default without Redis being unreachable at all.
   */
  refreshTimeoutMs?: number;
  /** Profile used when `--profile` isn't given. */
  defaultProfile?: string;
  /** Named connections, selected with `--profile <name>` or `defaultProfile`. */
  profiles?: Record<string, ProfileConfig>;
}

/**
 * One named connection. Either value may be written as `${VAR}` to read it
 * from the environment when the profile is used, keeping secrets out of the file.
 */
export interface ProfileConfig {
  redisUrl: string;
  prefix?: string;
}

/** The profile in effect, with its name for error messages and `doctor`'s source label. */
export interface SelectedProfile extends ProfileConfig {
  name: string;
}

/**
 * Every recognized config key with its validation floor. The parser is
 * driven off this table rather than special-casing one key, so adding a
 * setting here is enough to make it parse, validate, and appear in the
 * "did you mean" suggestions.
 */
const CONFIG_KEY_SPECS = {
  refreshIntervalMs: { min: MIN_REFRESH_INTERVAL_MS },
  refreshTimeoutMs: { min: MIN_REFRESH_TIMEOUT_MS },
} as const;

type ConfigKey = keyof typeof CONFIG_KEY_SPECS;

const PROFILE_CONFIG_KEYS = ['defaultProfile', 'profiles'] as const;

const KNOWN_CONFIG_KEYS: readonly string[] = [
  ...Object.keys(CONFIG_KEY_SPECS),
  ...PROFILE_CONFIG_KEYS,
];

const KNOWN_PROFILE_KEYS: readonly string[] = ['redisUrl', 'prefix'];

/**
 * Thrown for any problem with a config file the user can actually fix
 * (bad syntax, unknown key, invalid value). `message` is already
 * user-facing and includes the offending file's path — callers print it to
 * stderr and exit(1) rather than starting the dashboard with a config that
 * silently didn't apply.
 */
export class ConfigError extends Error {}

function levenshtein(a: string, b: string): number {
  const rows: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i += 1) rows[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      rows[i][j] =
        a[i - 1] === b[j - 1]
          ? rows[i - 1][j - 1]
          : 1 + Math.min(rows[i - 1][j], rows[i][j - 1], rows[i - 1][j - 1]);
    }
  }
  return rows[a.length][b.length];
}

/** Closest known key to an unrecognized one, for a "did you mean" hint — undefined if nothing is close enough to be useful. */
function suggestKey(key: string, knownKeys: readonly string[]): string | undefined {
  let best: { key: string; distance: number } | undefined;
  for (const known of knownKeys) {
    const distance = levenshtein(key.toLowerCase(), known.toLowerCase());
    if (best === undefined || distance < best.distance) {
      best = { key: known, distance };
    }
  }
  return best !== undefined && best.distance <= 3 ? best.key : undefined;
}

function didYouMean(key: string, knownKeys: readonly string[]): string {
  const suggestion = suggestKey(key, knownKeys);
  return suggestion ? ` — did you mean "${suggestion}"?` : '';
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseProfiles(value: unknown, filePath: string): Record<string, ProfileConfig> {
  if (!isPlainObject(value)) {
    throw new ConfigError(
      `${filePath}: "profiles" must be an object of named profiles, got: ${JSON.stringify(value)}`,
    );
  }
  const profiles: Record<string, ProfileConfig> = {};
  for (const [name, profile] of Object.entries(value)) {
    const where = `${filePath}: profile "${name}"`;
    if (name.trim() === '') {
      throw new ConfigError(`${filePath}: a profile name must not be empty`);
    }
    if (!isPlainObject(profile)) {
      throw new ConfigError(`${where} must be an object, got: ${JSON.stringify(profile)}`);
    }
    for (const field of Object.keys(profile)) {
      if (!KNOWN_PROFILE_KEYS.includes(field)) {
        throw new ConfigError(
          `${where}: unknown key "${field}"${didYouMean(field, KNOWN_PROFILE_KEYS)}`,
        );
      }
    }
    const { redisUrl, prefix } = profile;
    if (typeof redisUrl !== 'string' || redisUrl.trim() === '') {
      throw new ConfigError(
        `${where}: "redisUrl" is required and must be a non-empty string, got: ${JSON.stringify(redisUrl)}`,
      );
    }
    if (prefix !== undefined && (typeof prefix !== 'string' || prefix.trim() === '')) {
      throw new ConfigError(
        `${where}: "prefix" must be a non-empty string, got: ${JSON.stringify(prefix)}`,
      );
    }
    profiles[name] = prefix === undefined ? { redisUrl } : { redisUrl, prefix };
  }
  return profiles;
}

/**
 * Parses and validates one JSONC config file's contents. Pure — `source` is
 * whatever the caller already read from disk; `filePath` is only used to
 * prefix error messages. Throws `ConfigError` (never returns a partially
 * valid result) on a syntax error, an unrecognized key, or a value outside
 * `refreshIntervalMs`'s allowed range, per the fail-fast config policy.
 */
export function parseConfigFile(source: string, filePath: string): UserConfig {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(source, errors, { allowTrailingComma: true });

  if (errors.length > 0) {
    const [first] = errors;
    throw new ConfigError(
      `${filePath}: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${filePath}: expected a JSON object at the top level`);
  }

  const result: UserConfig = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!KNOWN_CONFIG_KEYS.includes(key)) {
      throw new ConfigError(
        `${filePath}: unknown config key "${key}"${didYouMean(key, KNOWN_CONFIG_KEYS)}`,
      );
    }
    if (key === 'defaultProfile') {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new ConfigError(
          `${filePath}: "defaultProfile" must be a non-empty string, got: ${JSON.stringify(value)}`,
        );
      }
      result.defaultProfile = value;
      continue;
    }
    if (key === 'profiles') {
      result.profiles = parseProfiles(value, filePath);
      continue;
    }
    const configKey = key as ConfigKey;
    const { min } = CONFIG_KEY_SPECS[configKey];

    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new ConfigError(
        `${filePath}: "${configKey}" must be an integer, got: ${JSON.stringify(value)}`,
      );
    }
    if (value < min) {
      const secondsHint = value > 0 ? ` — did you mean ${value * 1000} (${value} seconds)?` : '';
      throw new ConfigError(
        `${filePath}: "${configKey}" must be >= ${min}, got: ${value}${secondsHint}`,
      );
    }
    result[configKey] = value;
  }
  return result;
}

/**
 * Path to the user-level config file: `$XDG_CONFIG_HOME/bull-cli/config.json`,
 * falling back to `<home>/.config/bull-cli/config.json`. `env` and `home`
 * are injected (not read from `process.env`/`os.homedir()` here) so this
 * stays a pure, unit-testable function.
 */
export function userConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  return join(base, 'bull-cli', 'config.json');
}

/** Path to the project-level config file: `bull-cli.json` in `cwd`, looked up there only (no directory walking). */
export function projectConfigPath(cwd: string): string {
  return join(cwd, 'bull-cli.json');
}

/**
 * Resolves the effective refresh interval: project config overrides user
 * config overrides the default. Either config may be `null` (file absent).
 */
export function resolveRefreshIntervalMs(
  userConfig: UserConfig | null,
  projectConfig: UserConfig | null,
): number {
  return (
    projectConfig?.refreshIntervalMs ?? userConfig?.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
  );
}

/**
 * Resolves the effective per-refresh timeout: project config overrides user
 * config overrides the default. Either config may be `null` (file absent).
 */
export function resolveRefreshTimeoutMs(
  userConfig: UserConfig | null,
  projectConfig: UserConfig | null,
): number {
  return (
    projectConfig?.refreshTimeoutMs ?? userConfig?.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS
  );
}

/**
 * Picks the profile in effect: `--profile` if given, else `defaultProfile`,
 * else none. The two config files are merged first: the project file's
 * `defaultProfile` wins, and a project profile replaces a user profile of
 * the same name as a whole (fields aren't merged), so a project file's
 * `defaultProfile` may name a profile defined only in the user file.
 *
 * An unknown name is a `ConfigError` listing the available profiles, even
 * when `--redis` would make the profile's URL irrelevant: a mistyped profile
 * is still a mistake. `${VAR}` references aren't read here; see `resolveRedisUrl`.
 */
export function selectProfile(
  flag: string | undefined,
  userConfig: UserConfig | null,
  projectConfig: UserConfig | null,
): SelectedProfile | null {
  const profiles = { ...userConfig?.profiles, ...projectConfig?.profiles };
  const fromFlag = isSet(flag);
  const name = fromFlag ? flag : (projectConfig?.defaultProfile ?? userConfig?.defaultProfile);
  if (name === undefined) {
    return null;
  }
  const profile = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
  if (profile === undefined) {
    const names = Object.keys(profiles).sort();
    const origin = fromFlag ? '' : ' (set by "defaultProfile")';
    const available =
      names.length === 0
        ? 'no profiles are defined in the config files'
        : `available profiles: ${names.join(', ')}${didYouMean(name, names).replace(' — ', '; ')}`;
    throw new ConfigError(`Unknown profile "${name}"${origin}: ${available}`);
  }
  return { name, ...profile };
}

import { join } from 'node:path';
import { type ParseError, parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';

const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const DEFAULT_REDIS_PORT = 6379;
const DEFAULT_REDIS_DB = 0;
export const DEFAULT_BULLMQ_PREFIX = 'bull';
export const DEFAULT_REFRESH_INTERVAL_MS = 3000;
const MIN_REFRESH_INTERVAL_MS = 250;

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

/**
 * Resolves the Redis connection URL using the documented precedence:
 * `--redis` flag > `REDIS_URL` env var > default localhost URL.
 *
 * Empty or whitespace-only values (flag or env) are treated as absent.
 * Pure function — no I/O, no reliance on process globals (env is injected).
 */
export function resolveRedisUrl(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  if (flag !== undefined && flag.trim() !== '') {
    return flag;
  }

  const envUrl = env.REDIS_URL;
  if (envUrl !== undefined && envUrl.trim() !== '') {
    return envUrl;
  }

  return DEFAULT_REDIS_URL;
}

/**
 * Resolves the BullMQ Redis key prefix using the documented precedence:
 * `--prefix` flag > `BULLMQ_PREFIX` env var > `'bull'` default (bullmq's own
 * default).
 *
 * Empty or whitespace-only values (flag or env) are treated as absent.
 * Pure function — no I/O, no reliance on process globals (env is injected).
 */
export function resolvePrefix(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  if (flag !== undefined && flag.trim() !== '') {
    return flag;
  }

  const envPrefix = env.BULLMQ_PREFIX;
  if (envPrefix !== undefined && envPrefix.trim() !== '') {
    return envPrefix;
  }

  return DEFAULT_BULLMQ_PREFIX;
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
}

const KNOWN_CONFIG_KEYS = ['refreshIntervalMs'] as const;

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
function suggestConfigKey(key: string): string | undefined {
  let best: { key: string; distance: number } | undefined;
  for (const known of KNOWN_CONFIG_KEYS) {
    const distance = levenshtein(key.toLowerCase(), known.toLowerCase());
    if (best === undefined || distance < best.distance) {
      best = { key: known, distance };
    }
  }
  return best !== undefined && best.distance <= 3 ? best.key : undefined;
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
    if (!(KNOWN_CONFIG_KEYS as readonly string[]).includes(key)) {
      const suggestion = suggestConfigKey(key);
      throw new ConfigError(
        `${filePath}: unknown config key "${key}"${suggestion ? ` — did you mean "${suggestion}"?` : ''}`,
      );
    }

    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new ConfigError(
        `${filePath}: "refreshIntervalMs" must be an integer, got: ${JSON.stringify(value)}`,
      );
    }
    if (value < MIN_REFRESH_INTERVAL_MS) {
      const secondsHint = value > 0 ? ` — did you mean ${value * 1000} (${value} seconds)?` : '';
      throw new ConfigError(
        `${filePath}: "refreshIntervalMs" must be >= ${MIN_REFRESH_INTERVAL_MS}, got: ${value}${secondsHint}`,
      );
    }
    result.refreshIntervalMs = value;
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

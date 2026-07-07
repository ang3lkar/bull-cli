const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const DEFAULT_REDIS_PORT = 6379;
const DEFAULT_REDIS_DB = 0;
export const DEFAULT_BULLMQ_PREFIX = 'bull';

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

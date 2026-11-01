import type { Redis } from 'ioredis';
import {
  ConfigError,
  type ConfigSource,
  connectionFromUrl,
  parseConfigFile,
  prefixSource,
  redisUrlSource,
  resolvePrefix,
  resolveRedisUrl,
} from '../config.js';
import { discoverQueues } from './discovery.js';
import { maskRedisUrl, withRedisDb } from './format.js';
import { DOCTOR_COMMAND_TIMEOUT_MS, describeError } from './redis.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
  id: string;
  status: CheckStatus;
  message: string;
  hint?: string;
}

export interface DoctorReport {
  version: string;
  checks: Check[];
  summary: { ok: number; warn: number; fail: number; skip: number };
}

export interface DoctorDeps {
  redisFlag: string | undefined;
  prefixFlag: string | undefined;
  env: NodeJS.ProcessEnv;
  /** Paths of the user-level and project-level config files. */
  configPaths: { user: string; project: string };
  fileExists: (path: string) => boolean;
  readFile: (path: string) => string;
  /** Creates a fail-fast, lazily-connecting client (see `createDoctorRedisClient`). */
  createClient: (url: string) => Redis;
  /** Monotonic-ish millisecond clock, used for ping latency. */
  now: () => number;
  version: string;
}

const MAX_LISTED_QUEUES = 10;
const SCAN_COUNT = 1000;
const META_SUFFIX = ':meta';
/** Max candidate `*:meta` keys verified as BullMQ queues in the prefix lookup. */
const MAX_META_KEYS_CHECKED = 2000;
/** Field every BullMQ add-job script writes into a queue's meta hash. */
/** Ping failure messages that mean the server rejected our credentials. */
const AUTH_FAILURE = /^(WRONGPASS|NOAUTH|ERR invalid password)/;
/** SELECT failures (e.g. `redis://host/99`), reported only via the client's 'error' event. */
const DB_FAILURE = /DB index is out of range|invalid DB index/i;
const BULLMQ_META_FIELD = 'opts.maxLenEvents';

const SYMBOLS: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗', skip: '-' };

const SOURCE_LABELS = {
  redis: { flag: '--redis', env: 'REDIS_URL', default: 'default' },
  prefix: { flag: '--prefix', env: 'BULLMQ_PREFIX', default: 'default' },
} satisfies Record<string, Record<ConfigSource, string>>;

/** Masks credentials in free text: any `redis[s]://user:pass@` fragment, plus the literal password of `url`. */
function maskText(text: string, url: string): string {
  let result = text.replace(/(rediss?:\/\/[^:@\s/]*:)[^@\s]*@/g, '$1****@');
  try {
    const { password } = new URL(url);
    for (const secret of [password, safeDecode(password)]) {
      if (secret !== '') {
        result = result.split(secret).join('****');
      }
    }
  } catch {
    // unparseable URL: nothing more to mask
  }
  return result;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function errorText(error: unknown, url: string): string {
  const raw = error instanceof Error ? describeError(error) : String(error);
  return maskText(raw, url);
}

/**
 * Message for a failed connect/PING. The underlying connection error (from the
 * client's 'error' event) replaces ioredis's generic "Connection is closed.",
 * but never a more specific rejection such as a command timeout.
 */
function pingFailureMessage(
  error: unknown,
  lastConnectionError: Error | undefined,
  url: string,
): string {
  if (error instanceof Error && error.message === 'Command timed out') {
    return errorText(
      new Error(`Redis did not respond within ${DOCTOR_COMMAND_TIMEOUT_MS}ms (command timed out)`),
      url,
    );
  }
  const generic = error instanceof Error && /^Connection is closed/.test(error.message);
  return errorText(generic && lastConnectionError ? lastConnectionError : error, url);
}

function pingFailureHint(message: string): string {
  if (AUTH_FAILURE.test(message)) {
    return 'Redis rejected the credentials. Check the username/password in the URL (or ?password=).';
  }
  if (DB_FAILURE.test(message)) {
    return "The database number in the URL doesn't exist on this server.";
  }
  return 'Is Redis running and reachable at this URL?';
}

function checkConfig(deps: DoctorDeps): Check {
  const present: string[] = [];
  const failures: string[] = [];
  for (const path of [deps.configPaths.user, deps.configPaths.project]) {
    try {
      if (!deps.fileExists(path)) {
        continue;
      }
      parseConfigFile(deps.readFile(path), path);
      present.push(path);
    } catch (error) {
      failures.push(error instanceof ConfigError ? error.message : `${path}: ${String(error)}`);
    }
  }
  if (failures.length > 0) {
    return { id: 'config', status: 'fail', message: failures.join('; ') };
  }
  if (present.length === 0) {
    return { id: 'config', status: 'ok', message: 'No config files (using defaults)' };
  }
  return { id: 'config', status: 'ok', message: `Valid config: ${present.join(', ')}` };
}

function parseInfoFields(info: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of info.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0 && !line.startsWith('#')) {
      fields.set(line.slice(0, idx), line.slice(idx + 1).trim());
    }
  }
  return fields;
}

/** `INFO keyspace` → DB numbers (other than `currentDb`) that hold at least one key. */
function otherDbsWithKeys(info: string, currentDb: number): number[] {
  const dbs: number[] = [];
  for (const [key, value] of parseInfoFields(info)) {
    const match = /^db(\d+)$/.exec(key);
    const keys = /(?:^|,)keys=(\d+)/.exec(value);
    if (match && keys && Number(keys[1]) > 0 && Number(match[1]) !== currentDb) {
      dbs.push(Number(match[1]));
    }
  }
  return dbs.sort((a, b) => a - b);
}

/** `X:rest:meta` → `X` (non-empty X and rest), else null. */
function candidatePrefix(key: string): string | null {
  const idx = key.indexOf(':');
  if (idx <= 0 || key.length <= idx + 1 + META_SUFFIX.length || !key.endsWith(META_SUFFIX)) {
    return null;
  }
  return key.slice(0, idx);
}

/**
 * One SCAN pass for `*:meta`; returns prefix → number of BullMQ queues,
 * excluding `currentPrefix`. A `*:meta` key only counts if it is a hash with
 * BullMQ's `opts.maxLenEvents` field (pipelined HEXISTS; WRONGTYPE counts as
 * no) — app keys like `user:42:meta` are common and must not be suggested.
 * At most `MAX_META_KEYS_CHECKED` candidates are verified.
 */
async function scanOtherPrefixes(
  redis: Redis,
  currentPrefix: string,
): Promise<{ counts: Map<string, number>; capped: boolean }> {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  let checked = 0;
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `*${META_SUFFIX}`, 'COUNT', SCAN_COUNT);
    cursor = next;
    const candidates: Array<{ key: string; found: string }> = [];
    for (const key of batch) {
      const found = candidatePrefix(key);
      if (found === null || found === currentPrefix || seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (checked + candidates.length < MAX_META_KEYS_CHECKED) {
        candidates.push({ key, found });
      }
    }
    if (candidates.length > 0) {
      checked += candidates.length;
      const pipeline = redis.pipeline();
      for (const { key } of candidates) {
        pipeline.hexists(key, BULLMQ_META_FIELD);
      }
      const results = await pipeline.exec();
      candidates.forEach(({ found }, i) => {
        const [error, reply] = results?.[i] ?? [null, 0];
        if (error == null && reply === 1) {
          counts.set(found, (counts.get(found) ?? 0) + 1);
        }
      });
    }
  } while (cursor !== '0' && checked < MAX_META_KEYS_CHECKED);
  return { counts, capped: checked >= MAX_META_KEYS_CHECKED };
}

async function buildNoQueuesHint(
  redis: Redis,
  prefix: string,
  db: number,
  maskedUrl: string,
): Promise<string | undefined> {
  const parts: string[] = [];
  let lookupFailed = false;
  let capped = false;

  try {
    const scan = await scanOtherPrefixes(redis, prefix);
    const { counts } = scan;
    capped = scan.capped;
    if (counts.size > 0) {
      const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const list = sorted.map(([name, count]) => `"${name}" (${count})`).join(', ');
      parts.push(`Queues exist under prefix ${list}. Try --prefix ${sorted[0][0]}.`);
    }
  } catch {
    lookupFailed = true;
  }

  // The prefix is by far the likelier cause: only look at other DBs when no
  // other prefix was found, keeping the hint short.
  if (parts.length === 0) {
    try {
      const dbs = otherDbsWithKeys(await redis.info('keyspace'), db);
      if (dbs.length > 0) {
        parts.push(
          `Other databases have keys: ${dbs.map((n) => `db${n}`).join(', ')}. Try ${withRedisDb(maskedUrl, dbs[0])}.`,
        );
      }
    } catch {
      lookupFailed = true;
    }
  }

  if (parts.length > 0) {
    return parts.join(' ');
  }
  if (capped) {
    return `Checked the first ${MAX_META_KEYS_CHECKED} *:meta keys and found no BullMQ queues.`;
  }
  return lookupFailed
    ? undefined
    : 'No BullMQ keys found anywhere. Is this the right Redis instance?';
}

/**
 * Runs the fixed list of diagnostic checks in order, never aborting early:
 * a failed check is recorded and the rest still run (Redis-dependent ones are
 * `skip`ped when Redis can't be reached). Credentials never appear in the
 * report — URLs are masked and error text is scrubbed.
 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: Check[] = [];
  checks.push(checkConfig(deps));

  const url = resolveRedisUrl(deps.redisFlag, deps.env);
  const prefix = resolvePrefix(deps.prefixFlag, deps.env);
  const maskedUrl = maskRedisUrl(url);
  let db = 0;
  let urlValid = true;
  try {
    // ioredis prepends `redis://` to scheme-less input; parse the same way.
    db = connectionFromUrl(url.includes('://') ? url : `redis://${url}`).db;
    if (Number.isNaN(db)) {
      throw new Error('invalid database number');
    }
  } catch (error) {
    urlValid = false;
    checks.push({
      id: 'connection',
      status: 'fail',
      message: `Invalid Redis URL ${maskedUrl}: ${errorText(error, url)}`,
      hint: 'Expected redis[s]://[[user]:password@]host[:port][/db]',
    });
  }
  if (urlValid) {
    const urlSource = SOURCE_LABELS.redis[redisUrlSource(deps.redisFlag, deps.env)];
    const prefixSrc = SOURCE_LABELS.prefix[prefixSource(deps.prefixFlag, deps.env)];
    const check: Check = {
      id: 'connection',
      status: 'ok',
      message: `${maskedUrl} (${urlSource}), DB ${db}, prefix "${prefix}" (${prefixSrc})`,
    };
    const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
    const scheme = schemeMatch?.[1].toLowerCase();
    if (scheme !== 'redis' && scheme !== 'rediss') {
      check.status = 'warn';
      check.hint = `${scheme === undefined ? 'Missing scheme' : `Unexpected scheme "${scheme}"`}; expected the form redis://host:6379 (rediss:// for TLS).`;
    }
    checks.push(check);
  }

  const skip = (id: string, reason: string): Check => ({
    id,
    status: 'skip',
    message: `Skipped (${reason})`,
  });

  if (!urlValid) {
    checks.push(skip('ping', 'invalid Redis URL'));
    checks.push(skip('server', 'invalid Redis URL'));
    checks.push(skip('queues', 'invalid Redis URL'));
    return finish(deps.version, checks);
  }

  let redis: Redis | undefined;
  // A failed connect() rejects with a generic "Connection is closed."; the real
  // cause (e.g. ECONNREFUSED) only arrives as an 'error' event.
  let lastConnectionError: Error | undefined;
  try {
    let pingOk = false;
    try {
      const client = deps.createClient(url);
      redis = client;
      client.on('error', (error: Error) => {
        lastConnectionError = error;
      });
      await client.connect();
      const start = deps.now();
      const reply = await client.ping();
      // With no ready check, connect() doesn't wait on AUTH/SELECT replies, so
      // PING is pipelined behind them and can succeed while those failed; their
      // errors only arrive as 'error' events.
      if (lastConnectionError !== undefined) {
        throw lastConnectionError;
      }
      checks.push({
        id: 'ping',
        status: 'ok',
        message: `${reply} in ${Math.max(0, Math.round(deps.now() - start))}ms`,
      });
      pingOk = true;
    } catch (error) {
      const message = pingFailureMessage(error, lastConnectionError, url);
      checks.push({
        id: 'ping',
        status: 'fail',
        message,
        hint: pingFailureHint(message),
      });
    }

    if (!pingOk || redis === undefined) {
      checks.push(skip('server', 'Redis unreachable'));
      checks.push(skip('queues', 'Redis unreachable'));
    } else {
      checks.push(await checkServer(redis, url));
      checks.push(await checkQueues(redis, url, prefix, db, maskedUrl));
    }
  } finally {
    try {
      redis?.disconnect();
    } catch {
      // closing is best-effort
    }
  }

  return finish(deps.version, checks);
}

async function checkServer(redis: Redis, url: string): Promise<Check> {
  try {
    const fields = parseInfoFields(await redis.info('server'));
    const version = fields.get('redis_version') ?? 'unknown version';
    const mode = fields.get('redis_mode') ?? 'unknown mode';
    return { id: 'server', status: 'ok', message: `Redis ${version} (${mode})` };
  } catch (error) {
    return {
      id: 'server',
      status: 'warn',
      message: `Could not read INFO server: ${errorText(error, url)}`,
    };
  }
}

async function checkQueues(
  redis: Redis,
  url: string,
  prefix: string,
  db: number,
  maskedUrl: string,
): Promise<Check> {
  let names: string[];
  try {
    names = (await discoverQueues(redis, prefix)).map((q) => q.name);
  } catch (error) {
    return {
      id: 'queues',
      status: 'fail',
      message: `Queue discovery failed: ${errorText(error, url)}`,
    };
  }
  if (names.length > 0) {
    const listed = names.slice(0, MAX_LISTED_QUEUES).join(', ');
    const more =
      names.length > MAX_LISTED_QUEUES ? `, and ${names.length - MAX_LISTED_QUEUES} more` : '';
    return {
      id: 'queues',
      status: 'ok',
      message: `${names.length} ${names.length === 1 ? 'queue' : 'queues'}: ${listed}${more}`,
    };
  }
  const check: Check = {
    id: 'queues',
    status: 'warn',
    message: `No queues under prefix "${prefix}"`,
  };
  const hint = await buildNoQueuesHint(redis, prefix, db, maskedUrl);
  if (hint !== undefined) {
    check.hint = hint;
  }
  return check;
}

function finish(version: string, checks: Check[]): DoctorReport {
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) {
    summary[check.status] += 1;
  }
  return { version, checks, summary };
}

/** Process exit code for a report: 1 if any check failed (warnings are fine), else 0. */
export function doctorExitCode(report: DoctorReport): 0 | 1 {
  return report.summary.fail > 0 ? 1 : 0;
}

/** Plain-text report (no colours): one line per check, optional `hint:` line, then a summary line. */
export function formatDoctorReport(report: DoctorReport): string {
  const idWidth = Math.max(...report.checks.map((c) => c.id.length), 0);
  const indent = ' '.repeat(2 + idWidth + 2);
  const lines = [`bull-cli v${report.version} — doctor`, ''];
  for (const check of report.checks) {
    lines.push(`${SYMBOLS[check.status]} ${check.id.padEnd(idWidth)}  ${check.message}`);
    if (check.hint !== undefined) {
      lines.push(`${indent}hint: ${check.hint}`);
    }
  }
  const { ok, warn, fail, skip } = report.summary;
  lines.push(
    '',
    `${ok} ok, ${warn} ${warn === 1 ? 'warning' : 'warnings'}, ${fail} failed, ${skip} skipped`,
  );
  return lines.join('\n');
}

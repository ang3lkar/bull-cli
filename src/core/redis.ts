import { Redis } from 'ioredis';
import type { ConnectionStatus } from './types.js';

/**
 * Backoff for reconnection attempts. Fast failure feedback for the TUI
 * doesn't come from giving up here — `connect()` rejects and the `error`
 * event fires on the very first failed attempt regardless of this strategy.
 * This only controls the delay between *subsequent* reconnection attempts,
 * so it must never return `null`/`undefined` (which would permanently stop
 * reconnecting): a Redis restart or blip longer than the cap must not kill
 * the dashboard's ability to recover once Redis comes back.
 */
const RETRY_DELAY_STEP_MS = 200;
const MAX_RETRY_DELAY_MS = 2000;

function retryStrategy(times: number): number {
  return Math.min(times * RETRY_DELAY_STEP_MS, MAX_RETRY_DELAY_MS);
}

/**
 * Extracts a short, human-readable message from a connection error without
 * ever including a stack trace. Node's TCP connect failures often surface as
 * an `AggregateError` with an empty top-level `message`, so we fall back to
 * the nested error messages, then to an errno code, then to the error name.
 */
export function describeError(error: Error): string {
  if (error.message) {
    return error.message;
  }

  const nested = (error as { errors?: unknown[] }).errors;
  if (Array.isArray(nested) && nested.length > 0) {
    return nested.map((e) => (e instanceof Error ? e.message : String(e))).join('; ');
  }

  const code = (error as NodeJS.ErrnoException).code;
  return code ?? error.name ?? 'Unknown connection error';
}

/**
 * Creates a lazily-connecting ioredis client for the given URL, reporting
 * connection lifecycle changes via `onStatus`. Never throws: connection
 * failures surface as an `error` status carrying the attempted URL and a
 * human-readable message (no stack trace). The caller decides when to
 * `connect()`.
 */
export function createRedisClient(
  url: string,
  onStatus?: (status: ConnectionStatus) => void,
): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    retryStrategy,
  });

  client.on('connecting', () => {
    onStatus?.({ state: 'connecting' });
  });

  client.on('ready', () => {
    onStatus?.({ state: 'ready' });
  });

  // Always attach an 'error' listener: ioredis emits it on every failed
  // connection attempt and Node treats an unhandled 'error' event as a
  // fatal exception if no listener is registered.
  client.on('error', (error: Error) => {
    onStatus?.({ state: 'error', url, message: describeError(error) });
  });

  return client;
}

/** Per-command timeout for the doctor client (ms). */
export const DOCTOR_COMMAND_TIMEOUT_MS = 5000;

/**
 * Creates a lazily-connecting ioredis client for `bull-cli doctor`. Unlike
 * `createRedisClient` it must fail fast: no reconnection (`retryStrategy`
 * returns `null`), a single request retry, a 5s connect timeout and a 5s
 * `commandTimeout` (so a server that accepts the socket but never replies
 * can't hang it), so an unreachable Redis produces a diagnosis instead of
 * hanging. `enableReadyCheck: false` (doctor sends its own PING/INFO) and
 * `disableClientInfo: true` (no CLIENT SETINFO round trips) keep it quick. Takes the URL
 * string directly (as `createRedisClient` does) so `rediss:` TLS keeps working.
 */
export function createDoctorRedisClient(url: string): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    retryStrategy: () => null,
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    // connectTimeout only covers the TCP/TLS handshake; a server that accepts
    // the socket and then never replies (stalled tunnel, TLS-only endpoint)
    // would hang AUTH/PING/INFO forever. This also covers the commands
    // ioredis sends during connect().
    commandTimeout: DOCTOR_COMMAND_TIMEOUT_MS,
    // Doctor runs its own PING/INFO; the ready check would add an INFO and
    // can console.warn on restricted ACL users.
    enableReadyCheck: false,
    // Skips the CLIENT SETINFO commands ioredis sends on connect; against a
    // silent server they'd each wait out commandTimeout (~11s total, not ~5s).
    disableClientInfo: true,
  });
  // ioredis emits 'error' on a failed attempt; without a listener Node treats
  // it as fatal. The failure is reported via the rejected connect()/ping().
  client.on('error', () => {});
  return client;
}

import type { JobStatus } from './types.js';

const MIN_PROGRESS = 0;
const MAX_PROGRESS = 100;

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Normalizes a job's raw `progress` value for display: a finite number is
 * clamped to 0-100; anything else (an object, a string, `undefined`, `NaN`)
 * becomes `null` so the UI can render a `—` placeholder. The raw value is
 * always preserved separately (`JobDetail.rawProgress`) for the detail view.
 */
export function normalizeProgress(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return null;
  }
  return Math.min(MAX_PROGRESS, Math.max(MIN_PROGRESS, raw));
}

/**
 * Picks the timestamp to display for a job row/detail. Completed and failed
 * jobs prefer `finishedOn`, then `processedOn`, then the creation
 * `timestamp` (a job can be marked failed before ever being processed, e.g.
 * on a validation error). Every other status just shows the creation
 * `timestamp`. Falls back to 0 if all candidates are absent (defensive —
 * bullmq always sets `timestamp` in practice).
 */
export function displayTimestamp(
  job: { timestamp?: number; processedOn?: number; finishedOn?: number },
  status: JobStatus,
): number {
  if (status === 'completed' || status === 'failed') {
    return job.finishedOn ?? job.processedOn ?? job.timestamp ?? 0;
  }
  return job.timestamp ?? 0;
}

/**
 * Compact "time ago" string used by the footer and job rows. Negative
 * differences (clock skew, `fromMs` in the future) are clamped to 0s ago.
 */
export function relativeTime(fromMs: number, nowMs: number): string {
  const diffMs = Math.max(0, nowMs - fromMs);

  if (diffMs < MINUTE_MS) {
    return `${Math.floor(diffMs / SECOND_MS)}s ago`;
  }
  if (diffMs < HOUR_MS) {
    return `${Math.floor(diffMs / MINUTE_MS)}m ago`;
  }
  if (diffMs < DAY_MS) {
    return `${Math.floor(diffMs / HOUR_MS)}h ago`;
  }
  return `${Math.floor(diffMs / DAY_MS)}d ago`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Masks the password (if any) in a Redis connection URL before it's ever
 * rendered to the screen (Footer, ErrorScreen, EmptyState) — a URL like
 * `redis://:secret@host` must never show `secret` in the terminal.
 * `redis://user:pass@host` becomes `redis://user:****@host`;
 * `redis://:pass@host` becomes `redis://:****@host`. URLs without a
 * password — including username-only URLs like `redis://user@host`, which
 * must NOT have a password fabricated onto them — malformed input that
 * fails to parse, pass through unchanged (returning the original string
 * rather than a re-serialized `URL#toString()`, which could otherwise
 * normalize/append a trailing `/`).
 */
export function maskRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password === '') {
      return url;
    }
    parsed.password = '****';
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Human-readable timestamp for table/detail-view display, e.g. `2026-07-05
 * 14:03:21`, rendered in the local timezone (matches what a person sitting
 * at the terminal expects to see).
 */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hours = pad2(date.getHours());
  const minutes = pad2(date.getMinutes());
  const seconds = pad2(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

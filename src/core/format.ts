import type { JobStatus } from './types.js';

const MIN_PROGRESS = 0;
const MAX_PROGRESS = 100;

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

/**
 * Compact duration for the job detail view, e.g. `340ms`, `2.1s`, `4m 12s`,
 * `1h 5m`. Negative input (clock skew between workers) clamps to `0ms`.
 */
export function formatDuration(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  if (value < 1000) {
    return `${value}ms`;
  }
  if (value < 60_000) {
    return `${(value / 1000).toFixed(1)}s`;
  }
  const totalSeconds = Math.floor(value / 1000);
  if (totalSeconds < 3600) {
    return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
  }
  return `${Math.floor(totalSeconds / 3600)}h ${Math.floor((totalSeconds % 3600) / 60)}m`;
}

/**
 * How long a job waited before a worker picked it up, and how long it ran,
 * from its created/processed/finished timestamps. Each is `null` until both of
 * its timestamps exist. "Waited" includes any `delay` the job was added with.
 */
export function jobTimings(timestamps: {
  created: number;
  processed: number | null;
  finished: number | null;
}): { waited: string | null; ran: string | null } {
  const { created, processed, finished } = timestamps;
  return {
    waited: processed === null ? null : formatDuration(processed - created),
    ran: processed === null || finished === null ? null : formatDuration(finished - processed),
  };
}

/**
 * bullmq's `opts.attempts` is the total number of tries; it's absent (or 0)
 * when the job was added without retries, which means a single attempt.
 */
export function attemptsLimit(opts: unknown): number {
  const attempts = (opts as { attempts?: unknown } | null | undefined)?.attempts;
  return typeof attempts === 'number' && attempts > 1 ? Math.floor(attempts) : 1;
}

/** How a single stack trace line should be shown in the job detail view. */
export type StackLineKind = 'message' | 'frame' | 'library' | 'origin';

export interface StackLine {
  text: string;
  kind: StackLineKind;
}

/** Frames inside dependencies or Node itself, which are rarely where the bug is. */
function isLibraryFrame(line: string): boolean {
  return line.includes('node_modules') || /\(node:|at node:/.test(line);
}

/**
 * Splits bullmq's stacktrace entries (one multi-line stack string per failed
 * attempt) into lines and tags each one: `library` for dependency/Node
 * frames, `origin` for the first frame from the user's own code in each
 * entry, `frame` for the user's other frames, and `message` for everything
 * else (the `Error: ...` line and any continuation of a wrapped frame).
 */
export function classifyStack(entries: string[]): StackLine[] {
  const result: StackLine[] = [];
  for (const entry of entries) {
    let originFound = false;
    for (const text of entry.split('\n')) {
      let kind: StackLineKind = 'message';
      if (/^\s*at\s/.test(text)) {
        if (isLibraryFrame(text)) {
          kind = 'library';
        } else if (!originFound) {
          kind = 'origin';
          originFound = true;
        } else {
          kind = 'frame';
        }
      }
      result.push({ text, kind });
    }
  }
  return result;
}

/**
 * Maps bullmq's state string (from `job.getState()`) onto the status bucket
 * whose actions apply to it: `prioritized` and `waiting-children` jobs are
 * waiting in all but name. `undefined` for anything else (e.g. `unknown`).
 */
export function statusForState(state: string): JobStatus | undefined {
  switch (state) {
    case 'active':
    case 'waiting':
    case 'completed':
    case 'failed':
    case 'delayed':
      return state;
    case 'prioritized':
    case 'waiting-children':
      return 'waiting';
    default:
      return undefined;
  }
}

const EVERY_UNITS: Array<[label: string, ms: number]> = [
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1000],
  ['ms', 1],
];

/**
 * Compact interval for an `every` scheduler, e.g. `30s`, `5m`, `1h 30m`,
 * `500ms`: the two largest non-zero units (`1d 2h`, not `1d 2h 3m 4s`).
 */
export function formatEvery(ms: number): string {
  let rest = Math.max(0, Math.round(ms));
  if (rest === 0) {
    return '0ms';
  }
  const parts: string[] = [];
  for (const [label, size] of EVERY_UNITS) {
    const amount = Math.floor(rest / size);
    if (amount > 0) {
      parts.push(`${amount}${label}`);
      rest -= amount * size;
    }
    if (parts.length === 2) {
      break;
    }
  }
  return parts.join(' ');
}

/** The schedule column: the cron `pattern`, else `every <duration>`, else `—`. */
export function formatSchedule(scheduler: {
  pattern: string | null;
  every: number | null;
}): string {
  if (scheduler.pattern !== null) {
    return scheduler.pattern;
  }
  if (scheduler.every !== null) {
    return `every ${formatEvery(scheduler.every)}`;
  }
  return '—';
}

/**
 * Time until `target` relative to `now`, in one unit: `in 45s`, `in 2m`,
 * `in 3h`, `in 2d`. `overdue` once it is in the past, `—` when unknown.
 */
export function formatRelativeNext(target: number | null, now: number): string {
  if (target === null) {
    return '—';
  }
  const diff = target - now;
  if (diff < 0) {
    return 'overdue';
  }
  if (diff < 60_000) {
    return `in ${Math.ceil(diff / 1000)}s`;
  }
  if (diff < 3_600_000) {
    return `in ${Math.floor(diff / 60_000)}m`;
  }
  if (diff < 86_400_000) {
    return `in ${Math.floor(diff / 3_600_000)}h`;
  }
  return `in ${Math.floor(diff / 86_400_000)}d`;
}

/** Iterations column: `count`, or `count/limit` for a scheduler with a run limit. */
export function formatIterations(count: number, limit: number | null): string {
  return limit === null ? String(count) : `${count}/${limit}`;
}

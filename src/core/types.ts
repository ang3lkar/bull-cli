/** BullMQ job status buckets surfaced as dashboard tabs. */
export type JobStatus = 'active' | 'waiting' | 'completed' | 'failed' | 'delayed';

/** A tab in the jobs view: a job status bucket, or the queue's job schedulers. */
export type Tab = JobStatus | 'schedulers';

/** State of the Redis connection, as observed by the store/UI. */
export type ConnectionStatus =
  | { state: 'connecting' }
  | { state: 'ready' }
  | { state: 'error'; url: string; message: string };

/** A discovered BullMQ queue. */
export interface QueueInfo {
  name: string;
  isPaused: boolean;
}

/** Row shown in the job list table. */
export interface JobSummary {
  id: string;
  name: string;
  attemptsMade: number;
  timestamp: number;
  /** Clamped 0-100, or `null` when the job's raw progress isn't a number. */
  progress: number | null;
}

/** Full job payload shown in the job detail view. */
export interface JobDetail extends JobSummary {
  data: unknown;
  returnvalue: unknown;
  stacktrace: string[];
  opts: unknown;
  timestamps: {
    created: number;
    processed: number | null;
    finished: number | null;
  };
  /** Unclamped, unmapped raw `job.progress` value (may be an object). */
  rawProgress: unknown;
  /**
   * bullmq's own state string from `job.getState()` — usually a `JobStatus`,
   * but can also be e.g. `prioritized`, `waiting-children` or `unknown`.
   */
  state: string;
  /** `job.failedReason`, or `null` when the job hasn't failed. */
  failedReason: string | null;
}

/** One page of a job list, as shown in the job list table. */
export interface JobPage {
  jobs: JobSummary[];
  totalCount: number;
  page: number;
  pageCount: number;
  /** Job count for every status tab (not just the requested one), for the tab row's counts. */
  counts: Record<JobStatus, number>;
}

/** Ephemeral inline notification, e.g. for a failed job action. */
export interface Toast {
  id: number;
  message: string;
}

/**
 * Outcome of a job/queue action (`src/core/actions.ts`). Actions never
 * throw — every failure (missing job, wrong state, a bullmq-thrown error
 * such as trying to remove a locked/active job) is normalized into
 * `{ ok: false, message }` with a human-readable message (no stack traces),
 * so the store can surface it uniformly as a toast. `info` carries an
 * optional human-readable note on success, e.g. which way
 * `togglePauseQueue` went.
 */
export type ActionResult = { ok: true; info?: string } | { ok: false; message: string };

/** Row shown in the job scheduler list table. */
export interface SchedulerSummary {
  key: string;
  name: string;
  /** Cron pattern, or `null` for an `every` scheduler. */
  pattern: string | null;
  /** Repeat interval in milliseconds, or `null` for a cron scheduler. */
  every: number | null;
  tz: string | null;
  /** Next run time (epoch millis), or `null` when unknown. */
  next: number | null;
  iterationCount: number;
  limit: number | null;
}

/** Full scheduler payload shown in the scheduler detail view. */
export interface SchedulerDetail extends SchedulerSummary {
  startDate: number | null;
  endDate: number | null;
  offset: number | null;
  template: { data: unknown; opts: unknown };
  /** Id of the scheduler's next delayed job, confirmed to exist; `null` otherwise. */
  nextJobId: string | null;
}

/** One page of the job scheduler list, soonest-running first. */
export interface SchedulerPage {
  schedulers: SchedulerSummary[];
  totalCount: number;
  page: number;
  pageCount: number;
}

import { filterJobs } from './filter.js';
import { filterQueues, QUEUE_SORT_ORDER, type QueueSort, sortQueues } from './queueList.js';
import type {
  ActionResult,
  ConnectionStatus,
  JobDetail,
  JobPage,
  JobStatus,
  JobSummary,
  QueueInfo,
  RetrySummary,
  SchedulerDetail,
  SchedulerPage,
  SchedulerSummary,
  Tab,
  Toast,
} from './types.js';

/** Tab order used by the job-list header and `1`-`6` shortcuts; Schedulers is last. */
const TAB_ORDER: Tab[] = ['delayed', 'waiting', 'active', 'failed', 'completed', 'schedulers'];

const DEFAULT_POLL_INTERVAL_MS = 3000;
/**
 * Bounds a single `refresh()` cycle. With `maxRetriesPerRequest: null`
 * (see `redis.ts`), commands issued during a reconnect window wait
 * indefinitely — without this bound, a Redis blip could pin
 * `refreshing: true` forever. On timeout the cycle is abandoned and the
 * connection is marked error-ish; the next poll tick (or manual refresh)
 * tries again (plan's connection contract).
 */
const DEFAULT_REFRESH_TIMEOUT_MS = 5000;
/** How long a toast stays on screen before auto-dismissing. */
const DEFAULT_TOAST_DURATION_MS = 4000;

/** Toast text for a bulk retry: the retried and errored counts, plus the first error. */
export function retrySummaryMessage(result: RetrySummary): string {
  const plural = (n: number) => `${n} failed job${n === 1 ? '' : 's'}`;
  const [firstError] = result.errors;
  if (firstError === undefined) {
    return `Retried ${plural(result.retried)}`;
  }
  if (result.retried === 0) {
    return `Could not retry failed jobs: ${firstError.message}`;
  }
  return `Retried ${plural(result.retried)}, ${result.errored} errored: ${firstError.message}`;
}

export type Focus = 'sidebar' | 'jobs';
export type NavigationView =
  | { kind: 'queues' }
  | { kind: 'jobs'; queueName: string }
  | { kind: 'detail'; queueName: string; jobId: string }
  | { kind: 'scheduler'; queueName: string; key: string };

export type QueueCounts = Record<JobStatus, number>;

export type { QueueSort };

/**
 * Everything the store needs from the outside world, expressed purely in
 * terms of queue *names* (never `bullmq` `Queue` instances) so the store
 * can be unit-tested with plain fakes — no `bullmq`/`ioredis` involved. A
 * thin production adapter (Phase 8) wires this to `discovery.ts`,
 * `jobs.ts`, `actions.ts`, and `queueRegistry.ts`.
 */
export interface StoreDeps {
  discoverQueues(): Promise<QueueInfo[]>;
  fetchJobPage(queueName: string, status: JobStatus, page: number): Promise<JobPage>;
  /** Fetches counts without loading a page. Optional for lightweight test fakes. */
  fetchQueueCounts?(queueName: string): Promise<QueueCounts>;
  getJobDetail(queueName: string, jobId: string): Promise<JobDetail | null>;
  fetchSchedulerPage(queueName: string, page: number): Promise<SchedulerPage>;
  /**
   * Scheduler count for the Schedulers tab label, fetched with every refresh
   * of a job-status tab (the scheduler tab itself takes it from the page).
   * Optional for lightweight test fakes.
   */
  fetchSchedulerCount?(queueName: string): Promise<number>;
  getSchedulerDetail(queueName: string, key: string): Promise<SchedulerDetail | null>;
  /** Writes text to the system clipboard. */
  copyToClipboard?(text: string): Promise<void>;
  actions: {
    retry(queueName: string, jobId: string): Promise<ActionResult>;
    delete(queueName: string, jobId: string): Promise<ActionResult>;
    promote(queueName: string, jobId: string): Promise<ActionResult>;
    duplicate(queueName: string, jobId: string): Promise<ActionResult>;
    togglePause(queueName: string): Promise<ActionResult>;
    drain(queueName: string): Promise<ActionResult>;
    /** Retries every failed job in the queue (Failed tab `A`). Never throws. */
    retryAll(queueName: string): Promise<RetrySummary>;
  };
  /** Reconciles cached `Queue` instances against the discovered names. */
  syncRegistry(names: string[]): Promise<void>;
  /** Injectable clock, defaults to `Date.now`. */
  now?: () => number;
}

export interface StoreOptions {
  redisUrl: string;
  /** BullMQ key prefix the queues were discovered under, default `bull` (bullmq's own). */
  prefix?: string;
  /** Auto-refresh interval, default 3000ms (spec). */
  pollIntervalMs?: number;
  /** Per-refresh timeout bound, default 5000ms. */
  refreshTimeoutMs?: number;
  /** Toast auto-dismiss delay, default 4000ms. */
  toastDurationMs?: number;
}

/**
 * Immutable snapshot of all dashboard state, suitable for
 * `useSyncExternalStore`. A new object is produced on every real state
 * change; `getSnapshot()` returns the *same* reference between changes.
 */
export interface DashboardSnapshot {
  connection: ConnectionStatus;
  redisUrl: string;
  /** BullMQ key prefix in use, shown in the footer so it's clear which queues these are. */
  prefix: string;
  /** Every discovered queue, in discovery order — the EmptyState check reads this. */
  queues: QueueInfo[];
  /** `queues` after the sort and the name filter; the selected queue is always in here (or `null` when empty). */
  visibleQueues: QueueInfo[];
  queueSort: QueueSort;
  /** Name filter of the root queue list; separate from the job `search`, which selection changes reset. */
  queueFilter: { active: boolean; query: string };
  /** Last-known counts keyed by queue name, for the top-level queue table. */
  queueCounts: Readonly<Record<string, QueueCounts>>;
  navigationStack: readonly NavigationView[];
  currentView: NavigationView;
  selectedQueueName: string | null;
  tab: Tab;
  page: number;
  jobPage: JobPage | null;
  /** Current page of the Schedulers tab; `null` on every other tab and while loading. */
  schedulerPage: SchedulerPage | null;
  /** Scheduler count of the SELECTED queue (Schedulers tab label), `null` until first known. */
  schedulerCount: number | null;
  selectedSchedulerKey: string | null;
  schedulerDetail: SchedulerDetail | null;
  schedulerDetailLoading: boolean;
  /**
   * Last-known job count for every status tab of the SELECTED queue — the
   * selected queue's own entry in the same `queueCounts` cache the
   * top-level queue table reads. Sharing one cache is what makes entering
   * a queue instant: its counts are already known from the queue table
   * screen, so the tab row renders real numbers immediately and the
   * in-flight fetch merely updates them, rather than the row starting as
   * bare labels. Equally, a tab switch or a switch back to another queue
   * keeps showing that queue's numbers.
   *
   * The cache is keyed per queue name and only ever replaced by a fresh
   * result for that same name, so these are never another queue's counts;
   * a `jobPage === null` moment (mid tab/queue switch) or a failing fetch
   * does NOT clear it, so a queue that starts failing keeps its
   * last-known numbers. `null` only when no queue is selected, or before
   * the very first successful count fetch.
   */
  tabCounts: Record<JobStatus, number> | null;
  selectedJobId: string | null;
  search: { active: boolean; query: string };
  /** Jobs on the current page after the search filter is applied. */
  visibleJobs: JobSummary[];
  /**
   * How many jobs on the current page the active search query hides
   * (`jobPage.jobs.length - visibleJobs.length`), `0` when no query is
   * applied or nothing is filtered out. A non-zero value with an empty
   * `visibleJobs` is the third way the job list can have no rows: the
   * status isn't empty and the page isn't still loading — the query just
   * matches none of what's on it. Bounded by the page size, since
   * `filterJobs` only ever sees one page.
   */
  jobsHiddenBySearch: number;
  detail: JobDetail | null;
  detailLoading: boolean;
  /**
   * `true` while a queue/tab switch has cleared the job list and the fetch
   * that will refill it hasn't resolved yet. Without it, `jobPage === null`
   * conflates "not fetched yet" with "genuinely empty", so switching to a
   * tab whose count says 1 renders "No failed jobs" until the page lands.
   * Cleared by the END of a refresh cycle whether it succeeded or failed —
   * a failing queue must fall back to the empty table (plus its toast),
   * never to a loading message that never goes away.
   */
  jobsLoading: boolean;
  confirmDrain: boolean;
  /**
   * Job id awaiting duplicate ("clone") confirmation, or `null` when none
   * is pending. The id (and its queue) is captured at request time — see
   * `requestDuplicate` — so the prompt names the job it will actually act
   * on even if a background poll re-resolves the selection meanwhile.
   */
  confirmDuplicateJobId: string | null;
  /** Job id awaiting delete confirmation, captured with its queue at request time. */
  confirmDeleteJobId: string | null;
  /** Pending "retry all failed jobs" confirmation, with the failed count shown in the prompt. */
  confirmRetryAll: { queueName: string; count: number } | null;
  focus: Focus;
  toasts: Toast[];
  lastUpdatedAt: number | null;
  refreshing: boolean;
  /**
   * `false` until the first refresh cycle has fully resolved (discovery +
   * per-queue counts), then permanently `true`. Distinguishes "we don't
   * know what's on this Redis yet" from "we looked and there are no
   * queues", which the connection status alone can't: the redis client's
   * `ready` event reaches `onConnectionStatus` well before `SCAN`-based
   * discovery returns, so `connection.state === 'ready'` coexists with an
   * empty `queues` on a slow/large instance. Latched, never reset — a
   * failing poll or a Redis blip must not flash the loading screen again
   * over data that's already on screen.
   */
  initialLoadComplete: boolean;
}

/**
 * Framework-agnostic dashboard state machine. Owns every behavior in the
 * spec (tabs, pagination, search, refresh/polling, focus, detail view, drain and
 * duplicate confirmations, toasts, action dispatch, connection/error
 * handling) with
 * zero UI dependencies — `src/core/**` must never import `ink`/`react`.
 *
 * Design notes (latitude left by the spec, decided here):
 * - **Queue/tab switch** resets page + selected job + search, but *keeps*
 *   the current tab when switching queues (only `selectTab` changes tab).
 * - **Refresh coalescing**: if `refresh()` is called while one is already
 *   in flight, exactly one trailing refresh is queued (not dropped, not
 *   stacked) — a `R` press during a poll still gets a fresh result without
 *   piling up unbounded concurrent fetches.
 * - **Poll timer reset**: every call to `refresh()` (manual, poll-tick, or
 *   triggered by an action/navigation) restarts the poll interval, so the
 *   next auto-tick is always a full interval after the most recent refresh
 *   — this is what makes "manual refresh resets the interval" true without
 *   a separate code path.
 * - **Toast timing**: default 4s auto-dismiss; timers are tracked and
 *   cleared on `dispose()`/early dismiss so nothing keeps the process
 *   alive or leaks across store instances.
 */
export class DashboardStore {
  private readonly deps: StoreDeps;
  private readonly redisUrl: string;
  private readonly prefix: string;
  private readonly pollIntervalMs: number;
  private readonly refreshTimeoutMs: number;
  private readonly toastDurationMs: number;
  private readonly now: () => number;

  private readonly listeners = new Set<() => void>();
  private snapshot: DashboardSnapshot;

  // --- mutable state -------------------------------------------------
  private connection: ConnectionStatus = { state: 'connecting' };
  private queues: QueueInfo[] = [];
  private readonly queueCountsByName = new Map<string, QueueCounts>();
  private navigationStack: NavigationView[] = [{ kind: 'queues' }];
  private selectedQueueName: string | null = null;
  private tab: Tab = 'active';
  private page = 0;
  private jobPage: JobPage | null = null;
  private schedulerPage: SchedulerPage | null = null;
  private readonly schedulerCountByName = new Map<string, number>();
  private selectedSchedulerKey: string | null = null;
  private schedulerDetail: SchedulerDetail | null = null;
  private schedulerDetailLoading = false;
  private selectedJobId: string | null = null;
  private searchActive = false;
  private searchQuery = '';
  private queueSort: QueueSort = 'name';
  private queueFilterActive = false;
  private queueFilterQuery = '';
  private detail: JobDetail | null = null;
  private detailLoading = false;
  /** See `DashboardSnapshot.jobsLoading`. */
  private jobsLoading = false;
  private confirmDrainFlag = false;
  /** Pending delete confirmation, captured at request time. */
  private pendingDelete: { queueName: string; jobId: string } | null = null;
  /** Pending duplicate confirmation, captured at request time; see `requestDuplicate`. */
  private pendingDuplicate: { queueName: string; jobId: string } | null = null;
  /** Pending bulk retry, captured at request time; see `requestRetryAll`. */
  private pendingRetryAll: { queueName: string; count: number } | null = null;
  private focus: Focus = 'sidebar';
  private toasts: Toast[] = [];
  private lastUpdatedAt: number | null = null;
  private refreshing = false;
  /** Latched on the first fully-resolved refresh; see `DashboardSnapshot.initialLoadComplete`. */
  private initialLoadComplete = false;

  // --- refresh machinery ----------------------------------------------
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private refreshGeneration = 0;
  private refreshInFlight = false;
  private trailingRefreshRequested = false;
  private activeRefreshTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

  // --- toasts -----------------------------------------------------------
  private nextToastId = 1;
  private readonly toastTimers = new Map<number, ReturnType<typeof setTimeout>>();

  /**
   * Dedupe key for the per-queue job-fetch failure toast (see
   * `doRefreshWork`'s catch branch): `undefined` means no failure is
   * currently being tracked; `null` or a queue name records which failure
   * was last toasted, so a queue stuck failing across many poll ticks
   * doesn't flood a toast every `pollIntervalMs` — only the transition
   * *into* a (new) failure toasts. Reset to `undefined` on the next
   * successful fetch, so a later re-failure (even for the same queue)
   * toasts again.
   */
  private jobFetchErrorQueue: string | null | undefined;

  private disposed = false;

  constructor(deps: StoreDeps, opts: StoreOptions) {
    this.deps = deps;
    this.redisUrl = opts.redisUrl;
    this.prefix = opts.prefix ?? 'bull';
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.refreshTimeoutMs = opts.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
    this.toastDurationMs = opts.toastDurationMs ?? DEFAULT_TOAST_DURATION_MS;
    this.now = deps.now ?? (() => Date.now());
    this.snapshot = this.buildSnapshot();
  }

  // --- useSyncExternalStore contract -----------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): DashboardSnapshot {
    return this.snapshot;
  }

  private buildSnapshot(): DashboardSnapshot {
    const jobs = this.jobPage?.jobs ?? [];
    // Filtered once, then used for both `visibleJobs` and the hidden count,
    // so the two can never disagree about what the query matches.
    const visibleJobs = filterJobs(jobs, this.searchQuery);
    const queueCounts = Object.fromEntries(this.queueCountsByName) as Record<string, QueueCounts>;
    return Object.freeze({
      connection: this.connection,
      redisUrl: this.redisUrl,
      prefix: this.prefix,
      queues: this.queues,
      visibleQueues: this.visibleQueuesList(),
      queueSort: this.queueSort,
      queueFilter: { active: this.queueFilterActive, query: this.queueFilterQuery },
      queueCounts,
      navigationStack: this.navigationStack,
      currentView: this.navigationStack[this.navigationStack.length - 1],
      selectedQueueName: this.selectedQueueName,
      tab: this.tab,
      page: this.page,
      jobPage: this.jobPage,
      schedulerPage: this.schedulerPage,
      schedulerCount:
        this.selectedQueueName !== null
          ? (this.schedulerCountByName.get(this.selectedQueueName) ?? null)
          : null,
      selectedSchedulerKey: this.selectedSchedulerKey,
      schedulerDetail: this.schedulerDetail,
      schedulerDetailLoading: this.schedulerDetailLoading,
      tabCounts:
        this.selectedQueueName !== null
          ? (this.queueCountsByName.get(this.selectedQueueName) ?? null)
          : null,
      selectedJobId: this.selectedJobId,
      search: { active: this.searchActive, query: this.searchQuery },
      visibleJobs: visibleJobs,
      jobsHiddenBySearch: jobs.length - visibleJobs.length,
      detail: this.detail,
      detailLoading: this.detailLoading,
      jobsLoading: this.jobsLoading,
      confirmDrain: this.confirmDrainFlag,
      confirmDuplicateJobId: this.pendingDuplicate?.jobId ?? null,
      confirmDeleteJobId: this.pendingDelete?.jobId ?? null,
      confirmRetryAll: this.pendingRetryAll,
      focus: this.focus,
      toasts: this.toasts,
      lastUpdatedAt: this.lastUpdatedAt,
      refreshing: this.refreshing,
      initialLoadComplete: this.initialLoadComplete,
    });
  }

  /** Rebuilds the snapshot and notifies subscribers. Call after any mutation. */
  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) {
      listener();
    }
  }

  // --- refresh / polling ------------------------------------------------

  /**
   * Refreshes queues + the selected queue's current tab/page. Safe to call
   * concurrently: if a refresh is already running, this queues exactly one
   * trailing refresh (see class doc). Bounded by `refreshTimeoutMs` so a
   * Redis blip can't hang `refreshing: true` forever.
   */
  async refresh(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.restartPollTimerIfActive();

    if (this.refreshInFlight) {
      this.trailingRefreshRequested = true;
      return;
    }

    await this.runRefresh();
    while (this.trailingRefreshRequested) {
      this.trailingRefreshRequested = false;
      await this.runRefresh();
    }
  }

  private async runRefresh(): Promise<void> {
    this.refreshInFlight = true;
    this.refreshing = true;
    this.emit();

    const myGen = ++this.refreshGeneration;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      const handle = setTimeout(() => resolve('timeout'), this.refreshTimeoutMs);
      handle.unref?.();
      this.activeRefreshTimeoutHandle = handle;
    });

    try {
      const outcome = await Promise.race([
        this.doRefreshWork(myGen).then((): 'done' => 'done'),
        timeoutPromise,
      ]);

      if (myGen !== this.refreshGeneration) {
        // Reachable in practice: `invalidateInFlightRefresh()` (called by
        // every navigation intent — `selectQueue`/`selectTab`/paging/job
        // selection) bumps `refreshGeneration` mid-flight, independently of
        // the timeout branch below. `doRefreshWork`'s own internal
        // checkpoints are what actually stop it from applying stale writes
        // in that case (see `doRefreshWork`) and typically cause it to
        // `return` before even reaching this point; this check is a
        // redundant backstop for the outcome here (`'done'` arriving after
        // the generation has already moved on) so a stale `'done'` can
        // never fall through to the `outcome === 'timeout'` handling below.
        return;
      }

      if (outcome === 'timeout') {
        // Bump the generation so a late-resolving `doRefreshWork` can't
        // apply stale mutations after we've already moved on.
        this.refreshGeneration++;
        this.closeTextInputs();
        this.connection = {
          state: 'error',
          url: this.redisUrl,
          // Names the bound that was hit and the knob that moves it: a
          // reachable-but-distant Redis (a tunnelled/remote instance, where
          // discovery's round trips add up) hits this exactly like an
          // unreachable one does, and "may be unreachable" alone sends the
          // user hunting for a connection problem that isn't there.
          message: `Refresh timed out after ${this.refreshTimeoutMs}ms — Redis may be unreachable, or slow enough to need a larger "refreshTimeoutMs" in your bull-cli config`,
        };
      }
    } catch (err) {
      if (myGen === this.refreshGeneration) {
        this.closeTextInputs();
        this.connection = {
          state: 'error',
          url: this.redisUrl,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    } finally {
      if (this.activeRefreshTimeoutHandle) {
        clearTimeout(this.activeRefreshTimeoutHandle);
        this.activeRefreshTimeoutHandle = null;
      }
      this.refreshInFlight = false;
      this.refreshing = false;
      this.emit();
    }
  }

  /**
   * Closes the job search and queue filter inputs, keeping their queries (like
   * Enter). The error and empty-queues screens render no input, but the
   * keymap's capture gates would still treat `q` as a literal character there,
   * leaving the user unable to quit.
   */
  private closeTextInputs(): void {
    this.searchActive = false;
    this.queueFilterActive = false;
  }

  /**
   * Whether the dashboard body (which renders the search/filter inputs) is
   * on screen, mirroring `App`'s render branches: not the connection-error,
   * loading or no-queues screens. Opening an input anywhere else would leave
   * an invisible capture gate that swallows `q`. A reconnect (`connecting`)
   * keeps the body on screen, so it still counts as shown.
   */
  private inputsShown(): boolean {
    return this.connection.state !== 'error' && this.initialLoadComplete && this.queues.length > 0;
  }

  /**
   * Invalidates any refresh cycle currently in flight — harmless no-op if
   * none is running — by bumping the refresh generation. Every navigation
   * intent that changes what an in-flight `doRefreshWork` would otherwise
   * write back (selected queue, tab, page, or job selection) must call
   * this before mutating state: without it, a refresh started against the
   * OLD selection can finish awaiting Redis *after* the user has already
   * navigated elsewhere and clobber the new selection with its
   * captured-at-start values. Bumping the generation makes the in-flight
   * cycle's next `myGen !== this.refreshGeneration` checkpoint discard its
   * writes, exactly like a timed-out refresh does; the trailing refresh
   * that the navigation call itself triggers then runs fresh against the
   * current state.
   */
  private invalidateInFlightRefresh(): void {
    this.refreshGeneration++;
  }

  /**
   * The actual fetch sequence. Checks `myGen` after every `await` and bails
   * without mutating state once superseded (by a timeout bump, a
   * navigation-triggered invalidation, or a newer refresh generation), so
   * a hung/late promise can never clobber fresher state.
   *
   * **Failure-domain split** (per SPEC's error-handling philosophy — a
   * failure surfaces as a toast/inline, never crashes the whole session):
   * `discoverQueues()` is deliberately left OUTSIDE any try/catch here — a
   * failure there is connection-level (Redis itself is unreachable) and
   * must keep propagating to `runRefresh`'s catch, which sets the
   * full-screen connection-error state. Everything from that point on
   * (`syncRegistry` + the selected queue's `fetchJobPage`) is per-queue:
   * a queue whose name bullmq itself would reject (e.g. one containing
   * `:`, discoverable but not `new Queue(...)`-able — see
   * `queueRegistry.ts`) throws when the wiring layer tries to open it, but
   * that must NOT take down the whole dashboard, since discovery already
   * proved Redis is reachable and every OTHER queue is still browsable.
   * Such a failure is caught, the job list is cleared (not the sidebar —
   * `this.queues` was already set beforehand) so the UI shows an empty,
   * still-navigable job table, and a deduped toast reports it.
   */
  private async doRefreshWork(myGen: number): Promise<void> {
    const oldVisible = this.visibleQueuesList();
    const oldSelectedQueueName = this.selectedQueueName;

    const discovered = await this.deps.discoverQueues();
    if (myGen !== this.refreshGeneration) {
      return;
    }

    this.queues = discovered;
    if (discovered.length === 0) {
      this.closeTextInputs();
    }
    this.selectedQueueName = this.resolveSelectedQueueName(
      oldSelectedQueueName,
      oldVisible,
      this.visibleQueuesList(),
    );
    const queueName = this.selectedQueueName;
    const names = discovered.map((q) => q.name);

    try {
      await this.deps.syncRegistry(names);
      if (myGen !== this.refreshGeneration) {
        return;
      }

      if (this.deps.fetchQueueCounts) {
        const fetchQueueCounts = this.deps.fetchQueueCounts;
        const countResults = await Promise.allSettled(
          names.map(async (name) => [name, await fetchQueueCounts(name)] as const),
        );
        if (myGen !== this.refreshGeneration) {
          return;
        }
        for (const result of countResults) {
          if (result.status === 'fulfilled') {
            const [name, counts] = result.value;
            this.queueCountsByName.set(name, counts);
          }
        }
      }

      if (queueName === null) {
        this.jobPage = null;
        this.schedulerPage = null;
        this.selectedJobId = null;
        this.selectedSchedulerKey = null;
      } else if (this.tab === 'schedulers') {
        const prevSchedulers = this.schedulerPage?.schedulers ?? [];
        const prevKey = this.selectedSchedulerKey;

        const schedulerPage = await this.deps.fetchSchedulerPage(queueName, this.page);
        if (myGen !== this.refreshGeneration) {
          return;
        }

        this.page = schedulerPage.page;
        this.schedulerPage = schedulerPage;
        this.schedulerCountByName.set(queueName, schedulerPage.totalCount);
        this.selectedSchedulerKey = this.resolveSelectedSchedulerKey(
          prevKey,
          prevSchedulers,
          schedulerPage.schedulers,
        );
      } else {
        const prevJobs = this.jobPage?.jobs ?? [];
        const prevSelectedJobId = this.selectedJobId;

        // The scheduler count rides along with the page fetch (one ZCARD, in
        // parallel) so the Schedulers tab label stays current. A failure there
        // must never fail the job page, so it settles to `null` instead.
        const countPromise = this.deps.fetchSchedulerCount?.(queueName).catch(() => null);
        const [jobPage, schedulerCount] = await Promise.all([
          this.deps.fetchJobPage(queueName, this.tab, this.page),
          countPromise,
        ]);
        if (myGen !== this.refreshGeneration) {
          return;
        }

        if (typeof schedulerCount === 'number') {
          this.schedulerCountByName.set(queueName, schedulerCount);
        }
        this.page = jobPage.page;
        this.jobPage = jobPage;
        this.queueCountsByName.set(queueName, jobPage.counts);
        this.selectedJobId = this.resolveSelectedJobId(prevSelectedJobId, prevJobs, jobPage.jobs);
      }
      await this.refreshOpenDetail(myGen);
      if (myGen !== this.refreshGeneration) {
        return;
      }
      // Success (or nothing to fetch) clears the dedupe tracking, so a
      // later re-failure — even for the same queue — toasts again.
      this.jobFetchErrorQueue = undefined;
    } catch (err) {
      if (myGen !== this.refreshGeneration) {
        return;
      }
      this.jobPage = null;
      this.schedulerPage = null;
      // Deliberately NOT touching `queueCountsByName` here: it's keyed per
      // queue name, so a failing `fetchJobPage` for `queueName` simply
      // leaves that queue's entry as whatever it last was — this cycle's
      // `fetchQueueCounts`, which is a lighter call that a blip during the
      // heavier `getJobs` may not have hit; that queue's own last-known
      // counts; or absent (snapshot shows `null`) when it has never had
      // any, which is the case for a queue bullmq refuses to open at all
      // (a `:` in the name fails BOTH calls, every cycle — see
      // `queueRegistry.ts`). Either way it's never another queue's
      // counts, and the
      // failure is already surfaced via the toast below. The toast itself
      // only fires once per failure transition (deduped via
      // `jobFetchErrorQueue`), so the empty job table is the persistent
      // signal of an ongoing failure.
      this.selectedJobId = null;
      this.selectedSchedulerKey = null;
      if (this.jobFetchErrorQueue !== queueName) {
        this.jobFetchErrorQueue = queueName;
        const target = queueName !== null ? `queue "${queueName}"` : 'queues';
        this.pushToast(
          `Could not load ${target}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.connection = { state: 'ready' };
    this.lastUpdatedAt = this.now();
    // Deliberately here rather than in each branch above: every non-
    // superseded outcome — a landed page, no queue to load, or a failed
    // fetch — reaches this line, and a superseded cycle returns before it
    // instead of clearing a flag the navigation that superseded it just
    // set. A cycle killed by `refreshTimeoutMs` never resolves and so
    // leaves the flag set, but that's behind the full-screen connection
    // error until a later cycle clears it.
    this.jobsLoading = false;
    // Only reached by a cycle that survived every `myGen` checkpoint, so a
    // superseded/timed-out refresh never flips this — and it's after the
    // per-queue counts have landed, so the queue table has real numbers the
    // first time it's shown rather than a screen of zeros.
    this.initialLoadComplete = true;
  }

  /**
   * Reloads the job shown in the detail view, so it follows the job as it
   * changes state: a retry, a worker picking it up, progress, completion. A
   * job that has disappeared (deleted, or removed on completion) closes the
   * view with a toast. A failed reload keeps the last-loaded detail on
   * screen: a connection-level problem is already surfaced by the rest of
   * the refresh, and one bad fetch shouldn't blank the view.
   */
  private async refreshOpenDetail(myGen: number): Promise<void> {
    const view = this.currentView();
    if (view.kind === 'scheduler') {
      await this.refreshOpenSchedulerDetail(myGen, view);
      return;
    }
    if (view.kind !== 'detail' || this.detail === null) {
      return;
    }
    let detail: JobDetail | null;
    try {
      detail = await this.deps.getJobDetail(view.queueName, view.jobId);
    } catch {
      return;
    }
    if (myGen !== this.refreshGeneration || this.currentView() !== view) {
      return;
    }
    if (detail === null) {
      this.popView();
      this.pushToast(`Job ${view.jobId} no longer exists`);
      return;
    }
    this.detail = detail;
  }

  /** Scheduler counterpart of `refreshOpenDetail`: reloads the open scheduler, closing the view if it was removed. */
  private async refreshOpenSchedulerDetail(
    myGen: number,
    view: Extract<NavigationView, { kind: 'scheduler' }>,
  ): Promise<void> {
    if (this.schedulerDetail === null) {
      return;
    }
    let detail: SchedulerDetail | null;
    try {
      detail = await this.deps.getSchedulerDetail(view.queueName, view.key);
    } catch {
      return;
    }
    if (myGen !== this.refreshGeneration || this.currentView() !== view) {
      return;
    }
    if (detail === null) {
      this.popView();
      this.pushToast(`Scheduler ${view.key} no longer exists`);
      return;
    }
    this.schedulerDetail = detail;
  }

  /** Preserves the selected queue by name; clamps to the nearest remaining visible queue (by its old index in the visible order) if it vanished, or `null` if none are visible. */
  private resolveSelectedQueueName(
    prevName: string | null,
    prevQueues: QueueInfo[],
    nextQueues: QueueInfo[],
  ): string | null {
    if (nextQueues.length === 0) {
      return null;
    }
    if (prevName !== null && nextQueues.some((q) => q.name === prevName)) {
      return prevName;
    }
    if (prevName === null) {
      return nextQueues[0].name;
    }
    const oldIndex = prevQueues.findIndex((q) => q.name === prevName);
    // `oldIndex < 0` is defensive/unreachable in practice: `prevName` always
    // comes from `this.selectedQueueName`, which the store only ever sets
    // to a name in the visible list (`prevQueues` is that list as captured
    // before this refresh) — via `selectQueue`/`reconcileQueueSelection`
    // (which pick from the visible list) or a previous `doRefreshWork`
    // resolution (which picks from the visible list it just computed).
    /* v8 ignore next */
    const clamped = oldIndex < 0 ? 0 : Math.min(oldIndex, nextQueues.length - 1);
    return nextQueues[clamped].name;
  }

  /** Preserves the selected job by id; clamps to the nearest remaining job (by its old index) if it vanished, or `null` if the page is empty. */
  private resolveSelectedJobId(
    prevId: string | null,
    prevJobs: JobSummary[],
    nextJobs: JobSummary[],
  ): string | null {
    if (nextJobs.length === 0) {
      return null;
    }
    if (prevId !== null && nextJobs.some((j) => j.id === prevId)) {
      return prevId;
    }
    const oldIndex = prevJobs.findIndex((j) => j.id === prevId);
    const clamped = oldIndex < 0 ? 0 : Math.min(oldIndex, nextJobs.length - 1);
    return nextJobs[clamped].id;
  }

  /** Preserves the selected scheduler by key; clamps to the nearest remaining one (by its old index), or `null` if the page is empty. */
  private resolveSelectedSchedulerKey(
    prevKey: string | null,
    prevSchedulers: SchedulerSummary[],
    nextSchedulers: SchedulerSummary[],
  ): string | null {
    if (nextSchedulers.length === 0) {
      return null;
    }
    if (prevKey !== null && nextSchedulers.some((s) => s.key === prevKey)) {
      return prevKey;
    }
    const oldIndex = prevSchedulers.findIndex((s) => s.key === prevKey);
    const clamped = oldIndex < 0 ? 0 : Math.min(oldIndex, nextSchedulers.length - 1);
    return nextSchedulers[clamped].key;
  }

  /** Starts (or restarts) the 3s auto-refresh interval. Safe to call repeatedly. */
  startPolling(): void {
    this.resetPollTimer();
  }

  /** Stops the auto-refresh interval. Safe to call repeatedly/when not polling. */
  stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private resetPollTimer(): void {
    this.stopPolling();
    const handle = setInterval(() => {
      void this.refresh();
    }, this.pollIntervalMs);
    handle.unref?.();
    this.pollTimer = handle;
  }

  private restartPollTimerIfActive(): void {
    if (this.pollTimer !== null) {
      this.resetPollTimer();
    }
  }

  // --- connection ---------------------------------------------------------

  /**
   * Records a connection status change from the redis client's lifecycle
   * events. `error` is never terminal — the store keeps polling and, per
   * the plan's connection contract, auto-recovers: transitioning INTO
   * `ready` from a non-ready state triggers an immediate refresh.
   */
  onConnectionStatus(status: ConnectionStatus): void {
    const wasReady = this.connection.state === 'ready';
    this.connection = status;
    if (status.state === 'error') {
      this.closeTextInputs();
    }
    this.emit();
    if (status.state === 'ready' && !wasReady) {
      void this.refresh();
    }
  }

  // --- navigation -----------------------------------------------------

  /** Enters the selected queue's job list. The root queue view is never removed. */
  pushJobsView(): void {
    if (this.selectedQueueName === null || this.currentView().kind !== 'queues') {
      return;
    }
    this.navigationStack = [
      ...this.navigationStack,
      { kind: 'jobs', queueName: this.selectedQueueName },
    ];
    // Start every queue at the beginning of the job lifecycle. The status
    // header gives access to the remaining buckets even when Delayed is empty.
    if (this.tab !== 'delayed') {
      this.invalidateInFlightRefresh();
      this.tab = 'delayed';
      this.resetQueueOrTabSwitch();
      this.emit();
      void this.refresh();
      return;
    }
    this.emit();
  }

  /**
   * Pops one screen from the explicit navigation stack. Detail data is
   * discarded when leaving its screen so a later Enter always fetches live
   * state, while queue/job selection remains intact on the underlying view.
   */
  popView(): void {
    if (this.navigationStack.length === 1) {
      return;
    }
    const leaving = this.currentView();
    this.navigationStack = this.navigationStack.slice(0, -1);
    if (leaving.kind === 'detail') {
      this.detail = null;
      this.detailLoading = false;
    }
    if (leaving.kind === 'scheduler') {
      this.schedulerDetail = null;
      this.schedulerDetailLoading = false;
    }
    this.emit();
  }

  /**
   * Jumps straight back to the root queue dashboard from any depth, in one
   * key press. Same bookkeeping as `popView`, just applied to the whole
   * stack at once: detail data is discarded when leaving its screen, and
   * queue/tab/job selection and search state are all left intact.
   */
  popToQueues(): void {
    if (this.navigationStack.length === 1) {
      return;
    }
    this.navigationStack = [{ kind: 'queues' }];
    this.detail = null;
    this.detailLoading = false;
    this.schedulerDetail = null;
    this.schedulerDetailLoading = false;
    this.emit();
  }

  private currentView(): NavigationView {
    return this.navigationStack[this.navigationStack.length - 1];
  }

  /**
   * The sorted, then name-filtered queue list the root view renders. Sorting
   * is client-side over `queues` + the last-known counts, so it never needs a
   * fetch.
   */
  private visibleQueuesList(): QueueInfo[] {
    return filterQueues(
      sortQueues(this.queues, this.queueCountsByName, this.queueSort),
      this.queueFilterQuery,
    );
  }

  /**
   * Selects a queue by name or (0-based) index into the VISIBLE queue list.
   * Resets page, selected job, and search — but keeps the current
   * tab (only `selectTab` changes the tab). Never touches the queue filter.
   */
  selectQueue(nameOrIndex: string | number): void {
    const visible = this.visibleQueuesList();
    const name = typeof nameOrIndex === 'number' ? visible[nameOrIndex]?.name : nameOrIndex;
    if (name === undefined || !visible.some((q) => q.name === name)) {
      return;
    }
    if (this.setSelectedQueue(name)) {
      this.emit();
      void this.refresh();
    }
  }

  /**
   * Changes the selected queue without emitting or refreshing; returns whether
   * it changed (the caller then emits and refreshes). `null` (nothing visible)
   * leaves no job page and no selected job.
   */
  private setSelectedQueue(name: string | null): boolean {
    if (name === this.selectedQueueName) {
      return false;
    }
    this.invalidateInFlightRefresh();
    this.selectedQueueName = name;
    this.resetQueueOrTabSwitch();
    if (name === null) {
      this.jobsLoading = false;
    }
    return true;
  }

  /** Moves the queue selection to the next entry of the visible list, clamped at the end. */
  selectNextQueue(): void {
    this.moveQueueSelection(1);
  }

  /** Moves the queue selection to the previous entry of the visible list, clamped at the start. */
  selectPrevQueue(): void {
    this.moveQueueSelection(-1);
  }

  private moveQueueSelection(direction: 1 | -1): void {
    const visible = this.visibleQueuesList();
    if (visible.length === 0) {
      return;
    }
    const idx = visible.findIndex((q) => q.name === this.selectedQueueName);
    const nextIdx = idx < 0 ? 0 : Math.min(Math.max(idx + direction, 0), visible.length - 1);
    this.selectQueue(visible[nextIdx].name);
  }

  /**
   * Restores the invariant that the selection is in the visible list (or
   * `null` when it's empty) after the filter changed. Keeps a still-visible
   * selection; otherwise takes the first visible queue. Emits, and refreshes
   * whenever the selection changed (including to `null`, so counts don't lag a poll tick).
   */
  private reconcileQueueSelection(): void {
    const visible = this.visibleQueuesList();
    const stillVisible = visible.some((q) => q.name === this.selectedQueueName);
    const changed = stillVisible ? false : this.setSelectedQueue(visible[0]?.name ?? null);
    this.emit();
    if (changed) {
      void this.refresh();
    }
  }

  /** Selects a tab by value or (1-based) index, matching the `1`-`6` keys. */
  selectTab(statusOrIndex: Tab | number): void {
    let status: Tab | undefined;
    if (typeof statusOrIndex === 'number') {
      const idx = statusOrIndex - 1;
      status = idx >= 0 && idx < TAB_ORDER.length ? TAB_ORDER[idx] : undefined;
    } else {
      status = statusOrIndex;
    }
    if (status === undefined || status === this.tab) {
      return;
    }
    this.invalidateInFlightRefresh();
    this.tab = status;
    this.resetQueueOrTabSwitch();
    this.emit();
    void this.refresh();
  }

  /**
   * Steps one tab along the tab row — `1` forwards (towards Schedulers),
   * `-1` backwards — for the job list's `→`/`←` keys. Clamped
   * at both ends rather than wrapping, matching queue navigation and
   * pagination.
   *
   * Delegates to `selectTab`, so a press at either end is a true no-op
   * (same tab in, early return, no emit and no refresh) and a real move
   * gets the identical page/selection/filter reset the `1`-`5` keys give.
   */
  selectAdjacentTab(direction: 1 | -1): void {
    const currentIndex = TAB_ORDER.indexOf(this.tab);
    const nextIndex = Math.min(
      Math.max((currentIndex < 0 ? 0 : currentIndex) + direction, 0),
      TAB_ORDER.length - 1,
    );
    this.selectTab(TAB_ORDER[nextIndex]);
  }

  private resetQueueOrTabSwitch(): void {
    this.page = 0;
    this.jobPage = null;
    this.schedulerPage = null;
    this.selectedSchedulerKey = null;
    // Every caller (`setSelectedQueue`, `selectTab`, `pushJobsView`) triggers
    // a refresh immediately after, so this is always paired with a fetch that
    // will clear it (a `null` queue selection resets this flag itself).
    // Paging deliberately does NOT come through here: it keeps the old rows
    // on screen, so its `jobs.length` never lies.
    this.jobsLoading = true;
    this.selectedJobId = null;
    this.searchActive = false;
    this.searchQuery = '';
  }

  private currentPageCount(): number | null {
    const page = this.tab === 'schedulers' ? this.schedulerPage : this.jobPage;
    return page ? page.pageCount : null;
  }

  nextPage(): void {
    const pageCount = this.currentPageCount();
    if (pageCount === null || this.page >= pageCount - 1) {
      return;
    }
    this.invalidateInFlightRefresh();
    this.page += 1;
    this.selectedJobId = null;
    this.selectedSchedulerKey = null;
    this.emit();
    void this.refresh();
  }

  prevPage(): void {
    if (this.currentPageCount() === null || this.page <= 0) {
      return;
    }
    this.invalidateInFlightRefresh();
    this.page -= 1;
    this.selectedJobId = null;
    this.selectedSchedulerKey = null;
    this.emit();
    void this.refresh();
  }

  private visibleJobsList(): JobSummary[] {
    return filterJobs(this.jobPage?.jobs ?? [], this.searchQuery);
  }

  /** Moves the job selection to the next entry of the VISIBLE (filtered) list, clamped at the end. */
  selectNextJob(): void {
    const jobs = this.visibleJobsList();
    if (jobs.length === 0) {
      return;
    }
    this.invalidateInFlightRefresh();
    const idx = jobs.findIndex((j) => j.id === this.selectedJobId);
    const nextIdx = idx < 0 ? 0 : Math.min(idx + 1, jobs.length - 1);
    this.selectedJobId = jobs[nextIdx].id;
    this.emit();
  }

  /** Moves the job selection to the previous entry of the VISIBLE (filtered) list, clamped at the start. */
  selectPrevJob(): void {
    const jobs = this.visibleJobsList();
    if (jobs.length === 0) {
      return;
    }
    this.invalidateInFlightRefresh();
    const idx = jobs.findIndex((j) => j.id === this.selectedJobId);
    const prevIdx = idx < 0 ? 0 : Math.max(idx - 1, 0);
    this.selectedJobId = jobs[prevIdx].id;
    this.emit();
  }

  /** Moves the scheduler selection down, clamped at the end of the page. */
  selectNextScheduler(): void {
    this.moveSchedulerSelection(1);
  }

  /** Moves the scheduler selection up, clamped at the start of the page. */
  selectPrevScheduler(): void {
    this.moveSchedulerSelection(-1);
  }

  private moveSchedulerSelection(direction: 1 | -1): void {
    const schedulers = this.schedulerPage?.schedulers ?? [];
    if (this.tab !== 'schedulers' || schedulers.length === 0) {
      return;
    }
    this.invalidateInFlightRefresh();
    const idx = schedulers.findIndex((s) => s.key === this.selectedSchedulerKey);
    const nextIdx = idx < 0 ? 0 : Math.min(Math.max(idx + direction, 0), schedulers.length - 1);
    this.selectedSchedulerKey = schedulers[nextIdx].key;
    this.emit();
  }

  setFocus(focus: Focus): void {
    if (this.focus === focus) {
      return;
    }
    this.focus = focus;
    this.emit();
  }

  toggleFocus(): void {
    this.setFocus(this.focus === 'sidebar' ? 'jobs' : 'sidebar');
  }

  // --- queue sort / filter ----------------------------------------------

  /** `s`: advances the queue list sort (name → total → failed → waiting → active → delayed → name). Never fetches. */
  cycleQueueSort(): void {
    const idx = QUEUE_SORT_ORDER.indexOf(this.queueSort);
    this.queueSort = QUEUE_SORT_ORDER[(idx + 1) % QUEUE_SORT_ORDER.length];
    this.emit();
  }

  /** `/` on the queue list: opens the filter input, resuming any query still applied (like `openSearch`). */
  openQueueFilter(): void {
    if (!this.inputsShown() || this.queueFilterActive || this.currentView().kind !== 'queues') {
      return;
    }
    this.queueFilterActive = true;
    this.emit();
  }

  setQueueFilterQuery(query: string): void {
    this.queueFilterQuery = query;
    this.reconcileQueueSelection();
  }

  /** Enter while typing: closes the input but keeps the query filtering the list. */
  acceptQueueFilter(): void {
    if (!this.queueFilterActive) {
      return;
    }
    this.queueFilterActive = false;
    this.emit();
  }

  /** Escape: closes the input AND clears the query. */
  closeQueueFilter(): void {
    if (!this.queueFilterActive && this.queueFilterQuery === '') {
      return;
    }
    this.queueFilterActive = false;
    this.queueFilterQuery = '';
    this.reconcileQueueSelection();
  }

  // --- search -----------------------------------------------------------

  /**
   * `/`: opens the search input. Deliberately does NOT reset `searchQuery`
   * — if a query is still applied from a prior `acceptSearch()` (Enter
   * closed the input but kept the filter), reopening the input resumes
   * editing that same query rather than silently discarding it. This is
   * safe/non-surprising specifically because `SearchBar` always renders the
   * lingering query visibly (as a dimmed "(filtered)" indicator) whenever
   * it's non-empty, even while the input itself is closed — so there's
   * never a stale query applied with no on-screen trace of it.
   */
  openSearch(): void {
    if (!this.inputsShown() || this.searchActive || this.tab === 'schedulers') {
      return;
    }
    this.searchActive = true;
    this.emit();
  }

  setSearchQuery(query: string): void {
    this.searchQuery = query;
    this.emit();
  }

  /** Escape: closes the search bar AND clears the query, per spec. */
  closeSearch(): void {
    if (!this.searchActive && this.searchQuery === '') {
      return;
    }
    this.searchActive = false;
    this.searchQuery = '';
    this.emit();
  }

  /**
   * Enter while typing: closes the search *input* but, unlike `closeSearch`,
   * KEEPS the query filtering the job list (a UI latitude decision — the
   * spec only pins down `Escape`'s "clear and return to full list"
   * behavior; see `useKeymap`'s doc comment for the full rationale).
   */
  acceptSearch(): void {
    if (!this.searchActive) {
      return;
    }
    this.searchActive = false;
    this.emit();
  }

  // --- detail view --------------------------------------------------------

  /**
   * Fetches and opens the detail view for the currently selected job.
   * Missing job (deleted mid-flight) surfaces a toast instead of opening
   * the view. Unlike `actions.ts`, `getJobDetail` is NOT covered by the
   * actions "never throws" contract — it makes live Redis calls
   * (`queue.getJob`, `job.getState`) that can reject on a connection blip
   * — so a rejection here is caught explicitly and normalized into a
   * toast, the same way a "not found" result is, instead of leaving
   * `detailLoading` stuck `true` forever and an unhandled rejection.
   */
  async openDetail(): Promise<void> {
    if (this.selectedQueueName === null || this.selectedJobId === null) {
      return;
    }
    if (this.currentView().kind === 'queues') {
      this.navigationStack = [
        ...this.navigationStack,
        { kind: 'jobs', queueName: this.selectedQueueName },
      ];
    }
    if (this.currentView().kind !== 'jobs') {
      return;
    }
    await this.loadJobDetail(this.selectedQueueName, this.selectedJobId);
  }

  /** Loads a job's detail and, if it exists, pushes the job `detail` view onto the stack. */
  private async loadJobDetail(queueName: string, jobId: string): Promise<void> {
    // A second Enter while a load is in flight must not push a second frame.
    if (this.detailLoading) {
      return;
    }
    // View identity (not `refreshGeneration`): a poll must not drop a real
    // Enter, but Esc/H while loading must not push onto the wrong stack.
    const view = this.currentView();
    this.detailLoading = true;
    this.emit();

    let detail: JobDetail | null;
    try {
      detail = await this.deps.getJobDetail(queueName, jobId);
    } catch (err) {
      this.detailLoading = false;
      this.pushToast(
        `Could not load job ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    this.detailLoading = false;
    if (this.currentView() !== view) {
      this.emit();
      return;
    }
    if (detail === null) {
      this.pushToast(`Job ${jobId} not found`);
      return;
    }
    this.detail = detail;
    this.navigationStack = [...this.navigationStack, { kind: 'detail', queueName, jobId }];
    this.emit();
  }

  // --- scheduler views ----------------------------------------------------

  /**
   * Enter on a scheduler row: loads the selected scheduler and pushes its
   * detail view. A scheduler removed mid-flight, or a failed load, surfaces
   * a toast instead (mirrors `openDetail`). A result that lands after the
   * user already navigated elsewhere is dropped.
   */
  async openSchedulerDetail(): Promise<void> {
    const view = this.currentView();
    if (
      view.kind !== 'jobs' ||
      this.tab !== 'schedulers' ||
      this.selectedQueueName === null ||
      this.selectedSchedulerKey === null
    ) {
      return;
    }
    if (this.schedulerDetailLoading) {
      return;
    }
    const queueName = this.selectedQueueName;
    const key = this.selectedSchedulerKey;

    this.schedulerDetailLoading = true;
    this.emit();

    let detail: SchedulerDetail | null;
    try {
      detail = await this.deps.getSchedulerDetail(queueName, key);
    } catch (err) {
      this.schedulerDetailLoading = false;
      this.pushToast(
        `Could not load scheduler ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    this.schedulerDetailLoading = false;
    // Tab and queue switches don't change the stack, so check them too.
    if (
      this.currentView() !== view ||
      this.tab !== 'schedulers' ||
      this.selectedQueueName !== queueName
    ) {
      this.emit();
      return;
    }
    if (detail === null) {
      this.pushToast(`Scheduler ${key} not found`);
      return;
    }
    this.schedulerDetail = detail;
    this.navigationStack = [...this.navigationStack, { kind: 'scheduler', queueName, key }];
    this.emit();
  }

  /** Enter in the scheduler detail: opens the job detail of its next delayed job, if it has one. */
  async openSchedulerNextJob(): Promise<void> {
    const view = this.currentView();
    const nextJobId = this.schedulerDetail?.nextJobId ?? null;
    if (view.kind !== 'scheduler' || nextJobId === null) {
      return;
    }
    await this.loadJobDetail(view.queueName, nextJobId);
  }

  closeDetail(): void {
    if (this.currentView().kind !== 'detail') {
      return;
    }
    this.popView();
  }

  // --- drain flow -----------------------------------------------------

  requestDrain(): void {
    if (this.selectedQueueName === null || this.confirmDrainFlag) {
      return;
    }
    this.confirmDrainFlag = true;
    this.emit();
  }

  cancelDrain(): void {
    if (!this.confirmDrainFlag) {
      return;
    }
    this.confirmDrainFlag = false;
    this.emit();
  }

  /** Confirms a pending drain request: calls `actions.drain`, toasts on failure, refreshes on success. */
  async confirmDrain(): Promise<void> {
    if (!this.confirmDrainFlag || this.selectedQueueName === null) {
      this.confirmDrainFlag = false;
      this.emit();
      return;
    }
    const queueName = this.selectedQueueName;
    this.confirmDrainFlag = false;
    this.emit();

    const result = await this.deps.actions.drain(queueName);
    if (!result.ok) {
      this.pushToast(result.message);
      return;
    }
    this.pushToast(result.info ?? 'Queue drained');
    await this.refresh();
  }

  // --- duplicate ("clone") flow -----------------------------------------

  /**
   * `c`: asks for confirmation before duplicating the selected job. The
   * queue AND job id are captured NOW, not at confirm time: the background
   * poll keeps running while the prompt is up, and a refresh can re-resolve
   * `selectedJobId` (e.g. the job finished and vanished from the page) —
   * confirming must act on the job the user was looking at when they
   * pressed `c`, never on whatever the selection drifted to since.
   */
  requestDuplicate(): void {
    const target = this.currentJobTarget();
    if (target === null || this.pendingDuplicate !== null) {
      return;
    }
    this.pendingDuplicate = target;
    this.emit();
  }

  cancelDuplicate(): void {
    if (this.pendingDuplicate === null) {
      return;
    }
    this.pendingDuplicate = null;
    this.emit();
  }

  /** Confirms a pending duplicate request: calls `actions.duplicate`, toasts on failure, refreshes on success. */
  async confirmDuplicate(): Promise<void> {
    if (this.pendingDuplicate === null) {
      return;
    }
    const { queueName, jobId } = this.pendingDuplicate;
    this.pendingDuplicate = null;
    this.emit();

    const result = await this.deps.actions.duplicate(queueName, jobId);
    if (!result.ok) {
      this.pushToast(result.message);
      return;
    }
    this.pushToast(result.info ?? `Job ${jobId} duplicated`);
    await this.refresh();
  }

  // --- bulk retry flow --------------------------------------------------

  /**
   * Failed tab `A`: asks for confirmation before retrying every failed job
   * in the selected queue. The queue and the count shown in the prompt are
   * captured now, like `requestDuplicate`, so a poll that lands while the
   * prompt is up can't change what the user is agreeing to. With no failed
   * jobs there is nothing to confirm, so it just says so.
   */
  requestRetryAll(): void {
    if (
      this.currentView().kind !== 'jobs' ||
      this.tab !== 'failed' ||
      this.selectedQueueName === null ||
      this.pendingRetryAll !== null
    ) {
      return;
    }
    const count = this.queueCountsByName.get(this.selectedQueueName)?.failed ?? 0;
    if (count === 0) {
      this.pushToast('No failed jobs to retry');
      return;
    }
    this.pendingRetryAll = { queueName: this.selectedQueueName, count };
    this.emit();
  }

  cancelRetryAll(): void {
    if (this.pendingRetryAll === null) {
      return;
    }
    this.pendingRetryAll = null;
    this.emit();
  }

  /** Confirms a pending bulk retry: toasts the retried/errored counts, then refreshes. */
  async confirmRetryAll(): Promise<void> {
    if (this.pendingRetryAll === null) {
      return;
    }
    const { queueName } = this.pendingRetryAll;
    this.pendingRetryAll = null;
    this.emit();

    const result = await this.deps.actions.retryAll(queueName);
    this.pushToast(retrySummaryMessage(result));
    await this.refresh();
  }

  // --- delete confirmation / clipboard -----------------------------------

  /** Requests deletion of the current job, capturing its target before polling can move selection. */
  requestDelete(): void {
    const target = this.currentJobTarget();
    if (target === null || this.pendingDelete !== null) {
      return;
    }
    this.pendingDelete = target;
    this.emit();
  }

  cancelDelete(): void {
    if (this.pendingDelete === null) {
      return;
    }
    this.pendingDelete = null;
    this.emit();
  }

  async confirmDelete(): Promise<void> {
    if (this.pendingDelete === null) {
      return;
    }
    const target = this.pendingDelete;
    this.pendingDelete = null;
    this.emit();
    const result = await this.deps.actions.delete(target.queueName, target.jobId);
    if (!result.ok) {
      this.pushToast(result.message);
      return;
    }
    this.pushToast(result.info ?? `Job ${target.jobId} deleted`);
    if (this.currentView().kind === 'detail') {
      this.popView();
    }
    await this.refresh();
  }

  /** Copies the loaded detail payload, reporting clipboard failures as a toast. */
  async copyDetailData(): Promise<void> {
    if (this.currentView().kind !== 'detail' || this.detail === null) {
      return;
    }
    if (!this.deps.copyToClipboard) {
      this.pushToast('Clipboard support is unavailable');
      return;
    }
    try {
      await this.deps.copyToClipboard(JSON.stringify(this.detail.data, null, 2) ?? 'undefined');
      this.pushToast('Job data copied to clipboard');
    } catch (err) {
      this.pushToast(
        `Could not copy job data: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // --- job / queue actions ----------------------------------------------

  async retrySelected(): Promise<void> {
    await this.runJobAction((queueName, jobId) => this.deps.actions.retry(queueName, jobId));
  }

  async deleteSelected(): Promise<void> {
    await this.runJobAction((queueName, jobId) => this.deps.actions.delete(queueName, jobId));
  }

  async promoteSelected(): Promise<void> {
    await this.runJobAction((queueName, jobId) => this.deps.actions.promote(queueName, jobId));
  }

  private async runJobAction(
    action: (queueName: string, jobId: string) => Promise<ActionResult>,
  ): Promise<void> {
    const target = this.currentJobTarget();
    if (target === null) {
      return;
    }
    const result = await action(target.queueName, target.jobId);
    if (!result.ok) {
      this.pushToast(result.message);
      return;
    }
    if (result.info) {
      this.pushToast(result.info);
    }
    await this.refresh();
  }

  private currentJobTarget(): { queueName: string; jobId: string } | null {
    const view = this.currentView();
    if (view.kind === 'detail') {
      return { queueName: view.queueName, jobId: view.jobId };
    }
    if (view.kind === 'scheduler' || this.tab === 'schedulers') {
      return null;
    }
    if (this.selectedQueueName === null || this.selectedJobId === null) {
      return null;
    }
    return { queueName: this.selectedQueueName, jobId: this.selectedJobId };
  }

  /** Sidebar `p`: toggles pause/resume on the selected queue. */
  async togglePauseSelectedQueue(): Promise<void> {
    if (this.selectedQueueName === null) {
      return;
    }
    const result = await this.deps.actions.togglePause(this.selectedQueueName);
    if (!result.ok) {
      this.pushToast(result.message);
      return;
    }
    if (result.info) {
      this.pushToast(result.info);
    }
    await this.refresh();
  }

  // --- toasts -------------------------------------------------------------

  /** Pushes a toast, auto-dismissed after `toastDurationMs`. */
  pushToast(message: string): void {
    const id = this.nextToastId++;
    this.toasts = [...this.toasts, { id, message }];
    const handle = setTimeout(() => {
      this.dismissToast(id);
    }, this.toastDurationMs);
    handle.unref?.();
    this.toastTimers.set(id, handle);
    this.emit();
  }

  /** Dismisses a toast early (or is a no-op if already gone/unknown). */
  dismissToast(id: number): void {
    const timer = this.toastTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.toastTimers.delete(id);
    }
    const before = this.toasts.length;
    this.toasts = this.toasts.filter((t) => t.id !== id);
    if (this.toasts.length !== before) {
      this.emit();
    }
  }

  // --- lifecycle ------------------------------------------------------

  /** Stops polling and clears all pending timers. Idempotent. Does NOT close the queue registry — that's the wiring layer's job. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stopPolling();
    if (this.activeRefreshTimeoutHandle) {
      clearTimeout(this.activeRefreshTimeoutHandle);
      this.activeRefreshTimeoutHandle = null;
    }
    for (const timer of this.toastTimers.values()) {
      clearTimeout(timer);
    }
    this.toastTimers.clear();
    this.listeners.clear();
  }
}

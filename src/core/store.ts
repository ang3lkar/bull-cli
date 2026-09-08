import { filterJobs } from './filter.js';
import type {
  ActionResult,
  ConnectionStatus,
  JobDetail,
  JobPage,
  JobStatus,
  JobSummary,
  QueueInfo,
  Toast,
} from './types.js';

/** Status lifecycle order used by the job-list header and `1`-`5` shortcuts. */
const TAB_ORDER: JobStatus[] = ['delayed', 'waiting', 'active', 'failed', 'completed'];

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

export type Focus = 'sidebar' | 'jobs';
export type NavigationView =
  | { kind: 'queues' }
  | { kind: 'jobs'; queueName: string }
  | { kind: 'detail'; queueName: string; jobId: string };

export type QueueCounts = Record<JobStatus, number>;

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
  /** Writes text to the system clipboard. */
  copyToClipboard?(text: string): Promise<void>;
  actions: {
    retry(queueName: string, jobId: string): Promise<ActionResult>;
    delete(queueName: string, jobId: string): Promise<ActionResult>;
    promote(queueName: string, jobId: string): Promise<ActionResult>;
    duplicate(queueName: string, jobId: string): Promise<ActionResult>;
    togglePause(queueName: string): Promise<ActionResult>;
    drain(queueName: string): Promise<ActionResult>;
  };
  /** Reconciles cached `Queue` instances against the discovered names. */
  syncRegistry(names: string[]): Promise<void>;
  /** Injectable clock, defaults to `Date.now`. */
  now?: () => number;
}

export interface StoreOptions {
  redisUrl: string;
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
  queues: QueueInfo[];
  /** Last-known counts keyed by queue name, for the top-level queue table. */
  queueCounts: Readonly<Record<string, QueueCounts>>;
  navigationStack: readonly NavigationView[];
  currentView: NavigationView;
  selectedQueueName: string | null;
  tab: JobStatus;
  page: number;
  jobPage: JobPage | null;
  /**
   * Last-known job count for every status tab of the SELECTED queue,
   * cached per queue name so a tab switch (same queue) or a switch back to
   * a previously-visited queue shows its own real counts immediately
   * instead of flickering to bare labels. Only a fresh fetch result for a
   * given queue replaces that queue's cached entry — a `jobPage === null`
   * moment (mid tab/queue switch, or that queue's fetch failing) does NOT
   * clear it, so a queue that starts failing keeps showing its own
   * last-known counts (never another queue's) for as long as it keeps
   * failing. `null` when no queue is selected, or when the selected queue
   * has never had a successful fetch yet (including a queue that fails on
   * every attempt so far) — there is nothing cached for it to show.
   */
  tabCounts: Record<JobStatus, number> | null;
  selectedJobId: string | null;
  search: { active: boolean; query: string };
  /** Jobs on the current page after the search filter is applied. */
  visibleJobs: JobSummary[];
  detail: JobDetail | null;
  detailLoading: boolean;
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
  focus: Focus;
  toasts: Toast[];
  lastUpdatedAt: number | null;
  refreshing: boolean;
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
  private tab: JobStatus = 'active';
  private page = 0;
  private jobPage: JobPage | null = null;
  /** Last-known tab counts per queue name; see `DashboardSnapshot.tabCounts`. */
  private readonly tabCountsByQueue = new Map<string, Record<JobStatus, number>>();
  private selectedJobId: string | null = null;
  private searchActive = false;
  private searchQuery = '';
  private detail: JobDetail | null = null;
  private detailLoading = false;
  private confirmDrainFlag = false;
  /** Pending delete confirmation, captured at request time. */
  private pendingDelete: { queueName: string; jobId: string } | null = null;
  /** Pending duplicate confirmation, captured at request time; see `requestDuplicate`. */
  private pendingDuplicate: { queueName: string; jobId: string } | null = null;
  private focus: Focus = 'sidebar';
  private toasts: Toast[] = [];
  private lastUpdatedAt: number | null = null;
  private refreshing = false;

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
    const queueCounts = Object.fromEntries(this.queueCountsByName) as Record<string, QueueCounts>;
    return Object.freeze({
      connection: this.connection,
      redisUrl: this.redisUrl,
      queues: this.queues,
      queueCounts,
      navigationStack: this.navigationStack,
      currentView: this.navigationStack[this.navigationStack.length - 1],
      selectedQueueName: this.selectedQueueName,
      tab: this.tab,
      page: this.page,
      jobPage: this.jobPage,
      tabCounts:
        this.selectedQueueName !== null
          ? (this.tabCountsByQueue.get(this.selectedQueueName) ?? null)
          : null,
      selectedJobId: this.selectedJobId,
      search: { active: this.searchActive, query: this.searchQuery },
      visibleJobs: filterJobs(jobs, this.searchQuery),
      detail: this.detail,
      detailLoading: this.detailLoading,
      confirmDrain: this.confirmDrainFlag,
      confirmDuplicateJobId: this.pendingDuplicate?.jobId ?? null,
      confirmDeleteJobId: this.pendingDelete?.jobId ?? null,
      focus: this.focus,
      toasts: this.toasts,
      lastUpdatedAt: this.lastUpdatedAt,
      refreshing: this.refreshing,
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
        this.connection = {
          state: 'error',
          url: this.redisUrl,
          message: 'Refresh timed out — Redis may be unreachable',
        };
      }
    } catch (err) {
      if (myGen === this.refreshGeneration) {
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
    const oldQueues = this.queues;
    const oldSelectedQueueName = this.selectedQueueName;

    const discovered = await this.deps.discoverQueues();
    if (myGen !== this.refreshGeneration) {
      return;
    }

    this.queues = discovered;
    this.selectedQueueName = this.resolveSelectedQueueName(
      oldSelectedQueueName,
      oldQueues,
      discovered,
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
        this.selectedJobId = null;
      } else {
        const prevJobs = this.jobPage?.jobs ?? [];
        const prevSelectedJobId = this.selectedJobId;

        const jobPage = await this.deps.fetchJobPage(queueName, this.tab, this.page);
        if (myGen !== this.refreshGeneration) {
          return;
        }

        this.page = jobPage.page;
        this.jobPage = jobPage;
        this.tabCountsByQueue.set(queueName, jobPage.counts);
        this.queueCountsByName.set(queueName, jobPage.counts);
        this.selectedJobId = this.resolveSelectedJobId(prevSelectedJobId, prevJobs, jobPage.jobs);
      }
      // Success (or nothing to fetch) clears the dedupe tracking, so a
      // later re-failure — even for the same queue — toasts again.
      this.jobFetchErrorQueue = undefined;
    } catch (err) {
      if (myGen !== this.refreshGeneration) {
        return;
      }
      this.jobPage = null;
      // Deliberately NOT touching `tabCountsByQueue` here: the cache is
      // keyed per queue name, so a failing fetch for `queueName` simply
      // leaves that queue's entry as whatever it last was — its own
      // last-known counts if it has ever succeeded before, or absent
      // (snapshot shows `null`) if it never has. Either way it's never
      // another queue's counts, and the failure is already surfaced via
      // the toast below. A queue that fails on every attempt keeps
      // showing its own stale counts (or `null`) indefinitely — the toast
      // itself only fires once per failure transition (deduped via
      // `jobFetchErrorQueue`), so the empty job table is the persistent
      // signal of an ongoing failure.
      this.selectedJobId = null;
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
  }

  /** Preserves the selected queue by name; clamps to the nearest remaining queue (by its old index) if it vanished, or `null` if none are left. */
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
    // to a name that was present in `this.queues` (the same array
    // `prevQueues` captures here) — either via `selectQueue` (which
    // validates membership) or by a previous `doRefreshWork` resolution
    // (which always picks a name from the queues it just set).
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
    this.emit();
  }

  private currentView(): NavigationView {
    return this.navigationStack[this.navigationStack.length - 1];
  }

  /**
   * Selects a queue by name or (0-based) index into the current `queues`
   * list. Resets page, selected job, and search — but keeps the current
   * tab (only `selectTab` changes the tab).
   */
  selectQueue(nameOrIndex: string | number): void {
    let name: string | undefined;
    if (typeof nameOrIndex === 'number') {
      const queue = this.queues[nameOrIndex];
      name = queue ? queue.name : undefined;
    } else {
      name = nameOrIndex;
    }
    if (name === undefined || name === this.selectedQueueName) {
      return;
    }
    if (!this.queues.some((q) => q.name === name)) {
      return;
    }
    this.invalidateInFlightRefresh();
    this.selectedQueueName = name;
    this.resetQueueOrTabSwitch();
    this.emit();
    void this.refresh();
  }

  /** Selects a status tab by value or (1-based) index, matching the spec's `1`-`5` keys. */
  selectTab(statusOrIndex: JobStatus | number): void {
    let status: JobStatus | undefined;
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

  private resetQueueOrTabSwitch(): void {
    this.page = 0;
    this.jobPage = null;
    this.selectedJobId = null;
    this.searchActive = false;
    this.searchQuery = '';
  }

  nextPage(): void {
    if (!this.jobPage || this.page >= this.jobPage.pageCount - 1) {
      return;
    }
    this.invalidateInFlightRefresh();
    this.page += 1;
    this.selectedJobId = null;
    this.emit();
    void this.refresh();
  }

  prevPage(): void {
    if (!this.jobPage || this.page <= 0) {
      return;
    }
    this.invalidateInFlightRefresh();
    this.page -= 1;
    this.selectedJobId = null;
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
    if (this.searchActive) {
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
    const queueName = this.selectedQueueName;
    const jobId = this.selectedJobId;

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
    if (detail === null) {
      this.pushToast(`Job ${jobId} not found`);
      return;
    }
    this.detail = detail;
    this.navigationStack = [...this.navigationStack, { kind: 'detail', queueName, jobId }];
    this.emit();
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

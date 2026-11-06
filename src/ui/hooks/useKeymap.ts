import { type Key, useInput } from 'ink';
import type { DashboardSnapshot, DashboardStore } from '../../core/store.js';

/**
 * Single Ink `useInput` dispatcher for the whole app — every keybinding in
 * the spec's table is handled here, in one place, with a strict priority
 * order (highest first):
 *
 *   1. Input capture (typing into the job `/` search bar or the queue filter)
 *   2. `q`
 *   3. Confirmation prompt (y/n/Escape)
 *   4. Current navigation-stack view
 *
 * `q` quits everywhere except while an input is open, where it is a literal
 * character (names like `queue` need it). Ctrl+C still quits through cli.tsx.
 *
 * Latitude decisions the spec leaves open (documented here rather than left
 * implicit):
 *
 * - **Search `Enter` vs `Escape`**: while the search input is open,
 *   `Escape` clears the query and returns to the full list (explicit in the
 *   spec). `Enter` is unspecified — here it accepts the current query and
 *   closes just the input line (`store.acceptSearch()`), keeping the list
 *   filtered, so a user can type a filter, hit Enter to get the input out
 *   of the way, and keep browsing without the query being wiped out
 *   immediately after.
 * - **`Escape` once a filter is accepted** belongs to the view, not to the
 *   search: with the input closed, the jobs and detail views both take it
 *   as `popView()`, and an accepted filter stays applied across that pop
 *   (`popView` doesn't reset search state). Clearing such a filter in place
 *   therefore means reopening the input with `/` first, which is what puts
 *   `Escape` back in reach of `closeSearch()` — the wording of
 *   `JobTable`'s no-matches state points at exactly that path. `SearchBar`
 *   renders the lingering query whenever it's non-empty, so a filter that
 *   outlives its input is never invisible.
 * - **`/` opens search regardless of focus** (sidebar or jobs). The spec
 *   lists it under "Job list (focused)", but nothing else in the sidebar's
 *   keymap conflicts with it, and requiring an extra `Tab` press first
 *   would be a needless speed bump.
 * - **`H` jumps to the queue dashboard from any depth** and, like `r`, is
 *   handled above the view switch so it works from both the job list and
 *   job detail. It sits *below* the search and confirmation gates, so it
 *   stays a literal character while typing a filter (as do `s`, `p`, `D`
 *   and `r`) and is swallowed by a
 *   pending confirmation.
 * - **`q` is context-sensitive, not a global override**: it quits from the
 *   global and detail-view states, but is ignored while a drain
 *   confirmation is pending (only `y`/`Y`/`n`/`N`/`Escape` are honored
 *   there) and is treated as a literal character while typing in search or
 *   the queue filter.
 * - **Queue list**: `s` cycles the sort and `/` opens the name filter, which
 *   works like the job search (Enter keeps it, Esc clears it). Because the
 *   root view has nothing to pop, `Escape` there clears an accepted filter.
 * - **`←`/`→` step the tabs** in the job list, alongside the `1`-`6`
 *   jumps (`6` is Schedulers, whose own keys live in `handleSchedulersInput`): the vertical arrows move within a status, the horizontal ones
 *   move between them. They stay unbound in job detail, which has no tab
 *   row, and — being in `NAVIGATION_KEYS` — are inert while the search
 *   input is open rather than switching tabs out from under a filter.
 * - **Tab/queue navigation does not wrap** at the ends (clamped), matching
 *   the store's own pagination/job-selection clamping behavior elsewhere.
 */
export function useKeymap(
  store: DashboardStore,
  snapshot: DashboardSnapshot,
  onQuit: () => void,
): void {
  useInput((input, key) => {
    if (snapshot.search.active) {
      handleSearchInput(store, snapshot, input, key);
      return;
    }

    if (snapshot.queueFilter.active) {
      handleQueueFilterInput(store, snapshot, input, key);
      return;
    }

    if (input === 'q') {
      onQuit();
      return;
    }

    if (snapshot.confirmDeleteJobId !== null) {
      handleConfirmDeleteInput(store, input, key);
      return;
    }

    if (snapshot.confirmDrain) {
      handleConfirmDrainInput(store, input, key);
      return;
    }

    if (snapshot.confirmDuplicateJobId !== null) {
      handleConfirmDuplicateInput(store, input, key);
      return;
    }

    if (snapshot.confirmRetryAll !== null) {
      handleConfirmRetryAllInput(store, input, key);
      return;
    }

    if (snapshot.confirmRemoveQueue !== null) {
      handleConfirmRemoveQueueInput(store, input, key);
      return;
    }

    if (input === 'r') {
      void store.refresh();
      return;
    }

    if (input === 'H') {
      store.popToQueues();
      return;
    }

    switch (snapshot.currentView.kind) {
      case 'queues':
        handleQueueInput(store, snapshot, input, key);
        return;
      case 'jobs':
        if (snapshot.tab === 'schedulers') {
          handleSchedulersInput(store, input, key);
        } else {
          handleJobsInput(store, input, key);
        }
        return;
      case 'detail':
        handleDetailInput(store, input, key);
        return;
      case 'scheduler':
        handleSchedulerDetailInput(store, input, key);
    }
  });
}

const NAVIGATION_KEYS: Array<keyof Key> = [
  'upArrow',
  'downArrow',
  'leftArrow',
  'rightArrow',
  'pageUp',
  'pageDown',
  'tab',
  'home',
  'end',
];

function isPrintableInput(input: string, key: Key): boolean {
  if (input.length === 0 || key.ctrl || key.meta) {
    return false;
  }
  return !NAVIGATION_KEYS.some((flag) => key[flag]);
}

function handleSearchInput(
  store: DashboardStore,
  snapshot: DashboardSnapshot,
  input: string,
  key: Key,
): void {
  if (key.escape) {
    store.closeSearch();
    return;
  }
  if (key.return) {
    store.acceptSearch();
    return;
  }
  if (key.backspace || key.delete) {
    store.setSearchQuery(snapshot.search.query.slice(0, -1));
    return;
  }
  if (isPrintableInput(input, key)) {
    store.setSearchQuery(snapshot.search.query + input);
  }
}

function handleQueueFilterInput(
  store: DashboardStore,
  snapshot: DashboardSnapshot,
  input: string,
  key: Key,
): void {
  if (key.escape) {
    store.closeQueueFilter();
    return;
  }
  if (key.return) {
    store.acceptQueueFilter();
    return;
  }
  if (key.backspace || key.delete) {
    store.setQueueFilterQuery(snapshot.queueFilter.query.slice(0, -1));
    return;
  }
  if (isPrintableInput(input, key)) {
    store.setQueueFilterQuery(snapshot.queueFilter.query + input);
  }
}

function handleConfirmDrainInput(store: DashboardStore, input: string, key: Key): void {
  if (input === 'y' || input === 'Y') {
    void store.confirmDrain();
    return;
  }
  if (input === 'n' || input === 'N' || key.escape) {
    store.cancelDrain();
  }
}

function handleConfirmDuplicateInput(store: DashboardStore, input: string, key: Key): void {
  if (input === 'y' || input === 'Y') {
    void store.confirmDuplicate();
    return;
  }
  if (input === 'n' || input === 'N' || key.escape) {
    store.cancelDuplicate();
  }
}

function handleConfirmRetryAllInput(store: DashboardStore, input: string, key: Key): void {
  if (input === 'y' || input === 'Y') {
    void store.confirmRetryAll();
    return;
  }
  if (input === 'n' || input === 'N' || key.escape) {
    store.cancelRetryAll();
  }
}

function handleConfirmRemoveQueueInput(store: DashboardStore, input: string, key: Key): void {
  if (input === 'y' || input === 'Y') {
    void store.confirmRemoveQueue();
    return;
  }
  if (input === 'n' || input === 'N' || key.escape) {
    store.cancelRemoveQueue();
  }
}

function handleConfirmDeleteInput(store: DashboardStore, input: string, key: Key): void {
  if (input === 'y' || input === 'Y') {
    void store.confirmDelete();
    return;
  }
  if (input === 'n' || input === 'N' || key.escape) {
    store.cancelDelete();
  }
}

function handleQueueInput(
  store: DashboardStore,
  snapshot: DashboardSnapshot,
  input: string,
  key: Key,
): void {
  if (key.escape) {
    if (snapshot.queueFilter.query !== '') {
      store.closeQueueFilter();
    }
    return;
  }
  if (key.upArrow) {
    store.selectPrevQueue();
    return;
  }
  if (key.downArrow) {
    store.selectNextQueue();
    return;
  }
  if (input === 's') {
    store.cycleQueueSort();
    return;
  }
  if (input === '/') {
    store.openQueueFilter();
    return;
  }
  if (key.return) {
    store.pushJobsView();
    return;
  }
  if (input === 'p') {
    void store.togglePauseSelectedQueue();
    return;
  }
  if (input === 'D') {
    store.requestDrain();
    return;
  }
  if (input === 'X') {
    store.requestRemoveQueue();
  }
}

/** `←`/`→`, `1`-`6` and `b`/`n`, shared by the job-status tabs and the Schedulers tab. Returns whether the key was consumed. */
function handleTabAndPageKeys(store: DashboardStore, input: string, key: Key): boolean {
  if (key.leftArrow) {
    store.selectAdjacentTab(-1);
    return true;
  }
  if (key.rightArrow) {
    store.selectAdjacentTab(1);
    return true;
  }
  if (input >= '1' && input <= '6') {
    store.selectTab(Number(input));
    return true;
  }
  if (input === 'b') {
    store.prevPage();
    return true;
  }
  if (input === 'n') {
    store.nextPage();
    return true;
  }
  return false;
}

/**
 * Schedulers tab: read-only, so the job-only keys (`/`, `R`, `A`, `D`, `p`, `c`)
 * are deliberately unbound here.
 */
function handleSchedulersInput(store: DashboardStore, input: string, key: Key): void {
  if (key.escape || input === 'h') {
    store.popView();
    return;
  }
  if (key.upArrow) {
    store.selectPrevScheduler();
    return;
  }
  if (key.downArrow) {
    store.selectNextScheduler();
    return;
  }
  if (handleTabAndPageKeys(store, input, key)) {
    return;
  }
  if (key.return) {
    void store.openSchedulerDetail();
  }
}

function handleSchedulerDetailInput(store: DashboardStore, input: string, key: Key): void {
  if (key.escape || input === 'h') {
    store.popView();
    return;
  }
  if (key.return) {
    void store.openSchedulerNextJob();
  }
}

function handleJobsInput(store: DashboardStore, input: string, key: Key): void {
  if (key.escape || input === 'h') {
    store.popView();
    return;
  }
  if (input === '/') {
    store.openSearch();
    return;
  }
  if (key.upArrow) {
    store.selectPrevJob();
    return;
  }
  if (key.downArrow) {
    store.selectNextJob();
    return;
  }
  if (handleTabAndPageKeys(store, input, key)) {
    return;
  }
  if (key.return) {
    void store.openDetail();
    return;
  }
  if (input === 'R') {
    void store.retrySelected();
    return;
  }
  if (input === 'A') {
    store.requestRetryAll();
    return;
  }
  if (input === 'D') {
    store.requestDelete();
    return;
  }
  if (input === 'p') {
    void store.promoteSelected();
    return;
  }
  if (input === 'c') {
    store.requestDuplicate();
    return;
  }
}

function handleDetailInput(store: DashboardStore, input: string, key: Key): void {
  if (key.escape || input === 'h') {
    store.popView();
    return;
  }
  if (input === 'R') {
    void store.retrySelected();
    return;
  }
  if (input === 'D') {
    store.requestDelete();
    return;
  }
  if (input === 'p') {
    void store.promoteSelected();
    return;
  }
  if (input === 'c') {
    void store.copyDetailData();
  }
}

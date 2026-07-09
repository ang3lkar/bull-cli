import { type Key, useInput } from 'ink';
import type { DashboardSnapshot, DashboardStore } from '../../core/store.js';
import type { JobStatus } from '../../core/types.js';

/** Tab order, matching the spec's `1`-`5` keys and `store.ts`'s internal `TAB_ORDER` (not exported). */
const TAB_ORDER: JobStatus[] = ['active', 'waiting', 'completed', 'failed', 'delayed'];

/**
 * Single Ink `useInput` dispatcher for the whole app — every keybinding in
 * the spec's table is handled here, in one place, with a strict priority
 * order (highest first):
 *
 *   1. Search input capture (typing into the `/` search bar)
 *   2. Drain confirmation prompt (y/n/Escape)
 *   3. Detail modal open (Escape closes; `q` still quits)
 *   4. Global bindings (`q`, `R`, `Tab`, `/`, `Escape`)
 *   5. Focus-specific bindings (sidebar vs. job list)
 *
 * Latitude decisions the spec leaves open (documented here rather than left
 * implicit):
 *
 * - **Search `Enter` vs `Escape`**: `Escape` clears the query and returns to
 *   the full list (explicit in the spec). `Enter` is unspecified — here it
 *   accepts the current query and closes just the input line
 *   (`store.acceptSearch()`), keeping the list filtered, so a user can type
 *   a filter, hit Enter to get the input out of the way, and keep browsing
 *   without the query being wiped out immediately after.
 * - **Global `Escape`** (reached only when nothing above claims it — no
 *   active search input, no pending drain confirmation, no open modal) is
 *   routed to `store.closeSearch()` rather than being a true no-op: this is
 *   the only way to clear an "accepted" filter (see above) without
 *   switching queue/tab, and `closeSearch()` is already a safe no-op when
 *   there's nothing to clear.
 * - **`/` opens search regardless of focus** (sidebar or jobs). The spec
 *   lists it under "Job list (focused)", but nothing else in the sidebar's
 *   keymap conflicts with it, and requiring an extra `Tab` press first
 *   would be a needless speed bump.
 * - **`q` is context-sensitive, not a global override**: it quits from the
 *   global and detail-modal states, but is ignored while a drain
 *   confirmation is pending (only `y`/`Y`/`n`/`N`/`Escape` are honored
 *   there) and is treated as a literal character while typing in search.
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

    if (snapshot.confirmDrain) {
      handleConfirmDrainInput(store, input, key);
      return;
    }

    if (snapshot.detail !== null) {
      if (key.escape) {
        store.closeDetail();
        return;
      }
      if (input === 'q') {
        onQuit();
      }
      return;
    }

    if (input === 'q') {
      onQuit();
      return;
    }
    if (input === 'R') {
      void store.refresh();
      return;
    }
    if (key.tab) {
      store.toggleFocus();
      return;
    }
    if (input === '/') {
      store.openSearch();
      return;
    }
    if (key.escape) {
      store.closeSearch();
      return;
    }

    if (snapshot.focus === 'sidebar') {
      handleSidebarInput(store, snapshot, input, key);
    } else {
      handleJobsInput(store, snapshot, input, key);
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

function handleConfirmDrainInput(store: DashboardStore, input: string, key: Key): void {
  if (input === 'y' || input === 'Y') {
    void store.confirmDrain();
    return;
  }
  if (input === 'n' || input === 'N' || key.escape) {
    store.cancelDrain();
  }
}

function selectAdjacentQueue(
  store: DashboardStore,
  snapshot: DashboardSnapshot,
  direction: 1 | -1,
): void {
  const { queues, selectedQueueName } = snapshot;
  if (queues.length === 0) {
    return;
  }
  const currentIndex = queues.findIndex((q) => q.name === selectedQueueName);
  const nextIndex = Math.min(
    Math.max((currentIndex < 0 ? 0 : currentIndex) + direction, 0),
    queues.length - 1,
  );
  store.selectQueue(queues[nextIndex].name);
}

function handleSidebarInput(
  store: DashboardStore,
  snapshot: DashboardSnapshot,
  input: string,
  key: Key,
): void {
  if (key.upArrow) {
    selectAdjacentQueue(store, snapshot, -1);
    return;
  }
  if (key.downArrow) {
    selectAdjacentQueue(store, snapshot, 1);
    return;
  }
  if (input === 'p') {
    void store.togglePauseSelectedQueue();
    return;
  }
  if (input === 'D') {
    store.requestDrain();
  }
}

function selectAdjacentTab(
  store: DashboardStore,
  snapshot: DashboardSnapshot,
  direction: 1 | -1,
): void {
  const currentIndex = TAB_ORDER.indexOf(snapshot.tab);
  const nextIndex = Math.min(Math.max(currentIndex + direction, 0), TAB_ORDER.length - 1);
  store.selectTab(TAB_ORDER[nextIndex]);
}

function handleJobsInput(
  store: DashboardStore,
  snapshot: DashboardSnapshot,
  input: string,
  key: Key,
): void {
  if (key.upArrow) {
    store.selectPrevJob();
    return;
  }
  if (key.downArrow) {
    store.selectNextJob();
    return;
  }
  if (key.leftArrow) {
    selectAdjacentTab(store, snapshot, -1);
    return;
  }
  if (key.rightArrow) {
    selectAdjacentTab(store, snapshot, 1);
    return;
  }
  if (input >= '1' && input <= '5') {
    store.selectTab(Number(input));
    return;
  }
  if (input === 'b') {
    store.prevPage();
    return;
  }
  if (input === 'n') {
    store.nextPage();
    return;
  }
  if (key.return) {
    void store.openDetail();
    return;
  }
  if (input === 'r') {
    void store.retrySelected();
    return;
  }
  if (input === 'd') {
    void store.deleteSelected();
    return;
  }
  if (input === 'p') {
    void store.promoteSelected();
    return;
  }
  if (input === 'D') {
    store.requestDrain();
  }
}

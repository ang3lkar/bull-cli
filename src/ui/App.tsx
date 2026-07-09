import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import type { DashboardStore } from '../core/store.js';
import { ConfirmPrompt } from './ConfirmPrompt.js';
import { EmptyState } from './EmptyState.js';
import { ErrorScreen } from './ErrorScreen.js';
import { Footer, keyHintsFor } from './Footer.js';
import { useKeymap } from './hooks/useKeymap.js';
import { useStore } from './hooks/useStore.js';
import { useTerminalDimensions } from './hooks/useTerminalDimensions.js';
import { JobDetailModal } from './JobDetailModal.js';
import { JobTable } from './JobTable.js';
import { SearchBar } from './SearchBar.js';
import { Sidebar } from './Sidebar.js';
import { Tabs } from './Tabs.js';
import { Toast } from './Toast.js';

export interface AppProps {
  store: DashboardStore;
  onQuit(): void;
}

/** Fixed sidebar column width (spec's layout diagram shows a narrow left column). */
const SIDEBAR_WIDTH = 24;
/** How often the footer's "Last updated: Ns ago" counter re-renders. */
const NOW_TICK_MS = 1000;

/**
 * Ticking clock local to the UI layer (NOT the store — the plan is explicit
 * that this stays out of `DashboardStore`, which only tracks `lastUpdatedAt`
 * as a fixed point in time). Re-renders every `intervalMs` so `relativeTime`
 * output in the footer visibly counts up between refreshes.
 */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * Top-level app component: wires the `DashboardStore` to the presentational
 * components from Phase 7 and the single keyboard dispatcher from
 * `useKeymap`. Layout/overlay decisions left open by the spec:
 *
 * - Ink has no absolute/floating positioning by default, so the "centered
 *   modal overlay" (detail modal) and the drain confirmation prompt are
 *   rendered IN PLACE OF the job table (not on top of it) whenever they're
 *   open — in practice this reads the same as an overlay to someone using
 *   the dashboard (the underlying list is hidden while the modal/prompt is
 *   up), without needing a layout engine Ink doesn't have.
 * - `detailLoading` (fetching a job's detail) shows a small inline
 *   "Loading…" line above the job table rather than blocking the whole
 *   screen — the table lingers underneath so the user isn't staring at a
 *   blank pane while a job's data payload loads.
 */
export function App({ store, onQuit }: AppProps) {
  const snapshot = useStore(store);
  const now = useNow(NOW_TICK_MS);
  useKeymap(store, snapshot, onQuit);
  // `rows` is the real terminal height once running in the alt-screen buffer
  // (see `src/terminal.ts`), and `undefined` under ink-testing-library
  // (whose fake stdout has no `rows`) — `height={undefined}` is a no-op for
  // Yoga, so every existing test frame is unaffected.
  const { rows } = useTerminalDimensions();

  if (snapshot.connection.state === 'error') {
    return (
      <Box height={rows}>
        <ErrorScreen url={snapshot.connection.url} message={snapshot.connection.message} />
      </Box>
    );
  }

  if (snapshot.queues.length === 0) {
    return (
      <Box flexDirection="column" height={rows}>
        <Box flexGrow={1}>
          <EmptyState url={snapshot.redisUrl} />
        </Box>
        <Footer
          redisUrl={snapshot.redisUrl}
          lastUpdatedAt={snapshot.lastUpdatedAt}
          now={now}
          hints={keyHintsFor({
            searchActive: snapshot.search.active,
            confirmDrain: snapshot.confirmDrain,
            detailOpen: snapshot.detail !== null,
            focus: snapshot.focus,
          })}
        />
      </Box>
    );
  }

  const jobsFocused = snapshot.focus === 'jobs';

  return (
    <Box flexDirection="column" height={rows} paddingTop={1} paddingX={1}>
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" width={SIDEBAR_WIDTH} marginRight={3}>
          <Text bold>Queues</Text>
          <Box marginTop={1}>
            <Sidebar
              queues={snapshot.queues}
              selectedName={snapshot.selectedQueueName}
              focused={!jobsFocused}
            />
          </Box>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <Text bold>Jobs</Text>
          <Box flexDirection="column" marginTop={1}>
            <Box marginBottom={1}>
              <Tabs active={snapshot.tab} counts={snapshot.tabCounts} />
            </Box>
            {(snapshot.search.active || snapshot.search.query !== '') && (
              <Box marginBottom={1}>
                <SearchBar query={snapshot.search.query} active={snapshot.search.active} />
              </Box>
            )}
            {snapshot.confirmDrain ? (
              <ConfirmPrompt
                message={`Drain queue "${snapshot.selectedQueueName ?? ''}"? Removes all waiting and delayed jobs. (y/n)`}
              />
            ) : snapshot.detail !== null && !snapshot.detailLoading ? (
              <JobDetailModal detail={snapshot.detail} />
            ) : (
              <>
                {snapshot.detailLoading && <Text dimColor>Loading…</Text>}
                <JobTable
                  jobs={snapshot.visibleJobs}
                  selectedJobId={snapshot.selectedJobId}
                  page={snapshot.page}
                  pageCount={snapshot.jobPage?.pageCount ?? 1}
                  focused={jobsFocused}
                  now={now}
                />
              </>
            )}
          </Box>
        </Box>
      </Box>
      <Toast toasts={snapshot.toasts} />
      <Footer
        redisUrl={snapshot.redisUrl}
        lastUpdatedAt={snapshot.lastUpdatedAt}
        now={now}
        hints={keyHintsFor({
          searchActive: snapshot.search.active,
          confirmDrain: snapshot.confirmDrain,
          detailOpen: snapshot.detail !== null,
          focus: snapshot.focus,
        })}
      />
    </Box>
  );
}

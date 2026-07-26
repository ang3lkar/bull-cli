import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import type { DashboardStore } from '../core/store.js';
import { ConfirmPrompt } from './ConfirmPrompt.js';
import { EmptyState } from './EmptyState.js';
import { ErrorScreen } from './ErrorScreen.js';
import { Footer } from './Footer.js';
import { Header } from './Header.js';
import { useKeymap } from './hooks/useKeymap.js';
import { useStore } from './hooks/useStore.js';
import { useTerminalDimensions } from './hooks/useTerminalDimensions.js';
import { JobDetailModal } from './JobDetailModal.js';
import { JobTable } from './JobTable.js';
import { QueueTable } from './QueueTable.js';
import { SearchBar } from './SearchBar.js';
import { Tabs } from './Tabs.js';
import { Toast } from './Toast.js';

export interface AppProps {
  store: DashboardStore;
  onQuit(): void;
  /** App version for the title bar, from package.json (see `src/cli.tsx`). */
  version?: string;
}

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
 * components and single keyboard dispatcher from `useKeymap`. Only the
 * navigation stack's top view is rendered, keeping attention on one
 * full-width screen at a time.
 */
export function App({ store, onQuit, version = '0.0.0' }: AppProps) {
  const snapshot = useStore(store);
  const now = useNow(NOW_TICK_MS);
  useKeymap(store, snapshot, onQuit);
  // `rows` is the real terminal height once running in the alt-screen buffer
  // (see `src/terminal.ts`), and `undefined` under ink-testing-library
  // (whose fake stdout has no `rows`) — `height={undefined}` is a no-op for
  // Yoga, so every existing test frame is unaffected.
  const { columns, rows } = useTerminalDimensions();
  // Root padding consumes one column on each side.
  const contentWidth = columns === undefined ? undefined : Math.max(1, columns - 2);

  if (snapshot.connection.state === 'error') {
    return (
      <Box flexDirection="column" height={rows} paddingTop={1} paddingX={1}>
        <Header
          version={version}
          view={snapshot.currentView}
          status={snapshot.tab}
          width={contentWidth}
        />
        <Box flexGrow={1}>
          <ErrorScreen url={snapshot.connection.url} message={snapshot.connection.message} />
        </Box>
      </Box>
    );
  }

  if (snapshot.queues.length === 0) {
    return (
      <Box flexDirection="column" height={rows} paddingTop={1} paddingX={1}>
        <Header
          version={version}
          view={snapshot.currentView}
          status={snapshot.tab}
          width={contentWidth}
        />
        <Box flexGrow={1}>
          <EmptyState url={snapshot.redisUrl} />
        </Box>
        <Footer redisUrl={snapshot.redisUrl} lastUpdatedAt={snapshot.lastUpdatedAt} now={now} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={rows} paddingTop={1} paddingX={1}>
      <Header
        version={version}
        view={snapshot.currentView}
        status={snapshot.tab}
        width={contentWidth}
      />
      <Box flexDirection="column" flexGrow={1}>
        {snapshot.confirmDeleteJobId !== null ? (
          <ConfirmPrompt
            message={`Delete job ${snapshot.confirmDeleteJobId}? This cannot be undone. (y/n)`}
          />
        ) : snapshot.confirmDrain ? (
          <ConfirmPrompt
            message={`Drain queue "${snapshot.selectedQueueName ?? ''}"? Removes all waiting and delayed jobs. (y/n)`}
          />
        ) : snapshot.confirmDuplicateJobId !== null ? (
          <ConfirmPrompt
            message={`Duplicate job ${snapshot.confirmDuplicateJobId}? Adds a new delayed job with the same payload. (y/n)`}
          />
        ) : snapshot.currentView.kind === 'queues' ? (
          <>
            <Text bold>Queues</Text>
            <Box marginTop={1}>
              <QueueTable
                queues={snapshot.queues}
                counts={snapshot.queueCounts}
                selectedName={snapshot.selectedQueueName}
                width={contentWidth}
              />
            </Box>
          </>
        ) : snapshot.currentView.kind === 'jobs' ? (
          <>
            <Text bold>
              Jobs <Text dimColor>— {snapshot.currentView.queueName}</Text>
            </Text>
            <Box marginTop={1}>
              <Tabs active={snapshot.tab} counts={snapshot.tabCounts} />
            </Box>
            {(snapshot.search.active || snapshot.search.query !== '') && (
              <Box marginTop={1}>
                <SearchBar query={snapshot.search.query} active={snapshot.search.active} />
              </Box>
            )}
            <Box marginTop={1}>
              <JobTable
                jobs={snapshot.visibleJobs}
                status={snapshot.tab}
                selectedJobId={snapshot.selectedJobId}
                page={snapshot.page}
                pageCount={snapshot.jobPage?.pageCount ?? 1}
                width={contentWidth}
                counts={snapshot.tabCounts}
              />
            </Box>
          </>
        ) : snapshot.detailLoading || snapshot.detail === null ? (
          <Text dimColor>Loading job detail…</Text>
        ) : (
          <JobDetailModal detail={snapshot.detail} queueName={snapshot.currentView.queueName} />
        )}
      </Box>
      <Toast toasts={snapshot.toasts} />
      <Footer redisUrl={snapshot.redisUrl} lastUpdatedAt={snapshot.lastUpdatedAt} now={now} />
    </Box>
  );
}

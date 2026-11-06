import { Box, type DOMElement, measureElement, Text } from 'ink';
import { useEffect, useRef } from 'react';
import { statusForState } from '../core/format.js';
import type { DashboardStore } from '../core/store.js';
import { Breadcrumb } from './Breadcrumb.js';
import { ConfirmPrompt } from './ConfirmPrompt.js';
import { EmptyState } from './EmptyState.js';
import { ErrorScreen } from './ErrorScreen.js';
import { Footer } from './Footer.js';
import { Header } from './Header.js';
import { useKeymap } from './hooks/useKeymap.js';
import { useStore } from './hooks/useStore.js';
import { useTerminalDimensions } from './hooks/useTerminalDimensions.js';
import { JobDetailView } from './JobDetailView.js';
import { JobTable } from './JobTable.js';
import { Loading } from './Loading.js';
import { QueueMetrics } from './QueueMetrics.js';
import { QueueTable } from './QueueTable.js';
import { SchedulerDetailView } from './SchedulerDetailView.js';
import { SchedulerTable } from './SchedulerTable.js';
import { SearchBar } from './SearchBar.js';
import { Tabs } from './Tabs.js';
import { Toast } from './Toast.js';

/** Below this many terminal rows the blank spacer rows of the job list collapse. */
export const COMPACT_BELOW_ROWS = 24;

/** Rows of the table area that never hold a job: the column header and the page indicator (with its spacer unless compact). */
function tableChromeRows(compact: boolean): number {
  return 1 + (compact ? 1 : 2);
}

export interface AppProps {
  store: DashboardStore;
  onQuit(): void;
  /** App version for the title bar, from package.json (see `src/cli.tsx`). */
  version?: string;
}

/**
 * Top-level app component: wires the `DashboardStore` to the presentational
 * components and single keyboard dispatcher from `useKeymap`. Only the
 * navigation stack's top view is rendered, keeping attention on one
 * full-width screen at a time.
 */
export function App({ store, onQuit, version = '0.0.0' }: AppProps) {
  const snapshot = useStore(store);
  useKeymap(store, snapshot, onQuit);
  // `rows` is the real terminal height once running in the alt-screen buffer
  // (see `src/terminal.ts`), and `undefined` under ink-testing-library
  // (whose fake stdout has no `rows`) — `height={undefined}` is a no-op for
  // Yoga, so every existing test frame is unaffected.
  const { columns, rows } = useTerminalDimensions();
  // Root padding consumes one column on each side.
  const contentWidth = columns === undefined ? undefined : Math.max(1, columns - 2);
  // Fit mode needs a real terminal height to fit into; ink-testing-library has
  // none, and there the layout stays content-sized exactly as before.
  const fit = rows !== undefined;
  const compact = fit && rows < COMPACT_BELOW_ROWS;
  const tableAreaRef = useRef<DOMElement>(null);
  const toastRef = useRef<DOMElement>(null);

  // The job/scheduler list pages to however many rows fit (issue #5): the
  // table area is the one flexible box (zero basis, clipped), so its measured
  // height is the space left after every other piece of chrome — wrapped tab
  // rows, the search bar, the legend — without counting any of it by hand,
  // and it doesn't depend on the rows inside it, so this settles after one
  // `setPageSize`. Toast rows are added back: a toast is transient, and
  // letting it shrink the page would re-page the list twice every few
  // seconds; while one shows, the clipped area hides the bottom row(s)
  // (the page indicator first) instead.
  useEffect(() => {
    if (!fit || tableAreaRef.current === null) {
      return;
    }
    const area = measureElement(tableAreaRef.current).height;
    const toast = toastRef.current === null ? 0 : measureElement(toastRef.current).height;
    store.setPageSize(area + toast - tableChromeRows(compact));
  });

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

  if (!snapshot.initialLoadComplete) {
    return (
      <Box flexDirection="column" height={rows} paddingTop={1} paddingX={1}>
        <Header
          version={version}
          view={snapshot.currentView}
          status={snapshot.tab}
          width={contentWidth}
        />
        <Box flexGrow={1}>
          <Loading url={snapshot.redisUrl} />
        </Box>
        <Footer redisUrl={snapshot.redisUrl} prefix={snapshot.prefix} />
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
          <EmptyState url={snapshot.redisUrl} prefix={snapshot.prefix} />
        </Box>
        <Footer redisUrl={snapshot.redisUrl} prefix={snapshot.prefix} />
      </Box>
    );
  }

  // In job detail the available actions follow the job's own, live state
  // (a retried job is no longer failed) rather than the tab it was opened from.
  const actionStatus =
    snapshot.currentView.kind === 'detail' && snapshot.detail !== null
      ? statusForState(snapshot.detail.state)
      : snapshot.tab;

  // A job detail opened from a scheduler sits above that scheduler's view.
  const schedulerView = snapshot.navigationStack.find((view) => view.kind === 'scheduler');
  const openedFromScheduler =
    snapshot.currentView.kind === 'detail' && schedulerView?.kind === 'scheduler'
      ? schedulerView.key
      : undefined;

  return (
    <Box flexDirection="column" height={rows} paddingTop={1} paddingX={1}>
      <Header
        version={version}
        view={snapshot.currentView}
        status={actionStatus}
        width={contentWidth}
      />
      <Box
        flexDirection="column"
        flexGrow={1}
        {...(fit ? { flexShrink: 1, flexBasis: 0, overflow: 'hidden' as const } : {})}
      >
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
        ) : snapshot.confirmRetryAll !== null ? (
          <ConfirmPrompt
            message={`Retry all ${snapshot.confirmRetryAll.count} failed job${snapshot.confirmRetryAll.count === 1 ? '' : 's'} in "${snapshot.confirmRetryAll.queueName}"? They move back to waiting. (y/n)`}
          />
        ) : snapshot.confirmRemoveQueue !== null ? (
          <ConfirmPrompt message={removeQueuePrompt(snapshot.confirmRemoveQueue)} />
        ) : snapshot.currentView.kind === 'queues' ? (
          <>
            <Breadcrumb view={snapshot.currentView} sort={snapshot.queueSort} />
            <Box marginTop={1} flexShrink={0}>
              <QueueMetrics
                totals={snapshot.queueTotals}
                throughput={snapshot.throughput}
                width={contentWidth}
              />
            </Box>
            {(snapshot.queueFilter.active || snapshot.queueFilter.query !== '') && (
              <Box marginTop={1}>
                <SearchBar
                  query={snapshot.queueFilter.query}
                  active={snapshot.queueFilter.active}
                />
              </Box>
            )}
            <Box marginTop={1}>
              <QueueTable
                queues={snapshot.visibleQueues}
                totalCount={snapshot.queues.length}
                filterQuery={snapshot.queueFilter.query}
                counts={snapshot.queueCounts}
                selectedName={snapshot.selectedQueueName}
                width={contentWidth}
              />
            </Box>
          </>
        ) : snapshot.currentView.kind === 'jobs' ? (
          <>
            <Box flexShrink={0}>
              <Breadcrumb view={snapshot.currentView} status={snapshot.tab} />
            </Box>
            <Box marginTop={compact ? 0 : 1} flexShrink={0}>
              <Tabs
                active={snapshot.tab}
                counts={snapshot.tabCounts}
                schedulerCount={snapshot.schedulerCount}
              />
            </Box>
            {snapshot.tab !== 'schedulers' &&
              (snapshot.search.active || snapshot.search.query !== '') && (
                <Box marginTop={compact ? 0 : 1} flexShrink={0}>
                  <SearchBar query={snapshot.search.query} active={snapshot.search.active} />
                </Box>
              )}
            <Box
              ref={tableAreaRef}
              marginTop={compact ? 0 : 1}
              {...(fit ? { flexGrow: 1, flexBasis: 0, overflow: 'hidden' as const } : {})}
            >
              {snapshot.tab === 'schedulers' ? (
                <SchedulerTable
                  schedulers={snapshot.schedulerPage?.schedulers ?? []}
                  selectedKey={snapshot.selectedSchedulerKey}
                  page={snapshot.page}
                  pageCount={snapshot.schedulerPage?.pageCount ?? 1}
                  width={contentWidth}
                  loading={snapshot.jobsLoading}
                  compact={compact}
                />
              ) : (
                <JobTable
                  jobs={snapshot.visibleJobs}
                  status={snapshot.tab}
                  selectedJobId={snapshot.selectedJobId}
                  page={snapshot.page}
                  pageCount={snapshot.jobPage?.pageCount ?? 1}
                  width={contentWidth}
                  counts={snapshot.tabCounts}
                  loading={snapshot.jobsLoading}
                  hiddenBySearch={snapshot.jobsHiddenBySearch}
                  searchQuery={snapshot.search.query}
                  compact={compact}
                />
              )}
            </Box>
          </>
        ) : snapshot.currentView.kind === 'scheduler' ? (
          <>
            <Breadcrumb view={snapshot.currentView} />
            {snapshot.schedulerDetailLoading || snapshot.schedulerDetail === null ? (
              <Text dimColor>Loading scheduler detail…</Text>
            ) : (
              <SchedulerDetailView
                detail={snapshot.schedulerDetail}
                queueName={snapshot.currentView.queueName}
              />
            )}
          </>
        ) : (
          <>
            <Breadcrumb
              view={snapshot.currentView}
              status={snapshot.tab}
              schedulerKey={openedFromScheduler}
            />
            {snapshot.detailLoading || snapshot.detail === null ? (
              <Text dimColor>Loading job detail…</Text>
            ) : (
              <JobDetailView detail={snapshot.detail} queueName={snapshot.currentView.queueName} />
            )}
          </>
        )}
      </Box>
      <Box ref={toastRef} flexDirection="column" flexShrink={0}>
        <Toast toasts={snapshot.toasts} />
      </Box>
      <Box flexDirection="column" flexShrink={0}>
        <Footer redisUrl={snapshot.redisUrl} prefix={snapshot.prefix} />
      </Box>
    </Box>
  );
}

/** Prompt text for removing a queue; names the job count when it has loaded. */
function removeQueuePrompt({ queueName, total }: { queueName: string; total: number | null }) {
  const jobs =
    total === null ? 'all of its jobs' : `all ${total} of its job${total === 1 ? '' : 's'}`;
  return `Remove queue "${queueName}" and ${jobs}? This cannot be undone, and a running worker or producer will create it again. (y/n)`;
}

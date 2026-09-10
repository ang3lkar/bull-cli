import { Box, Text } from 'ink';
import { formatClock } from '../core/format.js';
import type { JobStatus, JobSummary } from '../core/types.js';

export interface JobTableProps {
  jobs: JobSummary[];
  status?: JobStatus;
  selectedJobId: string | null;
  /** 0-based current page (matches `DashboardSnapshot.page`/`JobPage.page`). */
  page: number;
  pageCount: number;
  /** Current terminal width; columns shrink predictably at narrow sizes. */
  width?: number;
  /** Counts for all status buckets, used to guide an empty list to useful alternatives. */
  counts?: Record<JobStatus, number> | null;
  /**
   * `true` while the page for this queue/tab is still being fetched (see
   * `DashboardSnapshot.jobsLoading`). An empty list then means "not loaded
   * yet", not "nothing here" — showing `EmptyJobs` would contradict the
   * tab row's own count right above it.
   */
  loading?: boolean;
  /**
   * How many rows on this page the active search hides (see
   * `DashboardSnapshot.jobsHiddenBySearch`). Non-zero with an empty `jobs`
   * means the search is why the table is blank, not the status.
   */
  hiddenBySearch?: number;
  /** The applied search query, quoted back in the no-matches state. */
  searchQuery?: string;
  /** @deprecated Single-focus views always render the selected row as focused. */
  focused?: boolean;
  /** @deprecated Kept for compatibility with older callers. */
  now?: number;
}

const ID_WIDTH = 10;
const NAME_WIDTH = 18;
const ATTEMPTS_WIDTH = 8;
const TIMESTAMP_WIDTH = 19;
/** Blank columns between each field, so values don't butt up against each other. */
const COL_GAP = '   ';

/** Truncates `s` to `width` chars, replacing the last char with `…` when it doesn't fit — simple, predictable, and easy to unit-test (no Ink text-wrapping involved). */
function truncate(s: string, width: number): string {
  if (s.length <= width) {
    return s;
  }
  if (width <= 1) {
    return s.slice(0, width);
  }
  return `${s.slice(0, width - 1)}…`;
}

function cell(value: string, width: number): string {
  return truncate(value, width).padEnd(width);
}

/** Like `cell`, but right-aligns within `width` — the convention for numeric columns (Attempts, Progress) so digits line up by place value. */
function rightCell(value: string, width: number): string {
  return truncate(value, width).padStart(width);
}

function selectionMarker(isSelected: boolean): string {
  if (!isSelected) {
    return '  ';
  }
  return '❯ ';
}

function columnWidths(width: number | undefined): { id: number; created: number; name: number } {
  if (width === undefined) {
    return { id: ID_WIDTH, created: TIMESTAMP_WIDTH, name: NAME_WIDTH };
  }
  if (width >= 80) {
    // Marker + ID + State + Attempts + CreatedAt + five column gaps.
    // Let Name absorb remaining room so rows visually align with the
    // full-width status header instead of ending at a fixed column.
    return { id: ID_WIDTH, created: TIMESTAMP_WIDTH, name: Math.max(12, width - 64) };
  }
  return { id: 8, created: 12, name: Math.max(12, width - 55) };
}

function headerLine(width: number | undefined): string {
  const columns = columnWidths(width);
  return [
    '  ',
    cell('ID', columns.id),
    cell('Name', columns.name),
    cell('State', 10),
    rightCell('Attempts', ATTEMPTS_WIDTH),
    cell('CreatedAt', columns.created),
  ].join(COL_GAP);
}

function rowLine(
  job: JobSummary,
  status: string,
  isSelected: boolean,
  width: number | undefined,
): string {
  const columns = columnWidths(width);
  return [
    selectionMarker(isSelected),
    cell(job.id, columns.id),
    cell(job.name, columns.name),
    cell(status, 10),
    rightCell(String(job.attemptsMade), ATTEMPTS_WIDTH),
    cell(formatClock(job.timestamp), columns.created),
  ].join(COL_GAP);
}

const STATUS_ORDER: JobStatus[] = ['delayed', 'waiting', 'active', 'failed', 'completed'];
const STATUS_KEYS: Record<JobStatus, string> = {
  delayed: '1',
  waiting: '2',
  active: '3',
  failed: '4',
  completed: '5',
};

function titleCase(value: string): string {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function statusColor(status: string): string | undefined {
  if (status === 'failed') {
    return 'red';
  }
  if (status === 'active') {
    return 'cyan';
  }
  if (status === 'waiting' || status === 'delayed') {
    return 'yellow';
  }
  return undefined;
}

function EmptyJobs({
  status,
  counts,
}: {
  status: JobStatus;
  counts: Record<JobStatus, number> | null | undefined;
}) {
  const alternatives =
    counts === null || counts === undefined
      ? []
      : STATUS_ORDER.filter((candidate) => candidate !== status && counts[candidate] > 0).map(
          (candidate) => `${STATUS_KEYS[candidate]} ${titleCase(candidate)}`,
        );

  return (
    <Box flexDirection="column" alignItems="center" marginTop={2}>
      <Text color={statusColor(status)} dimColor={status === 'completed'}>
        ◌ No {status} jobs
      </Text>
      <Text dimColor>This queue has no jobs in this status.</Text>
      {alternatives.length > 0 && <Text dimColor>Try {alternatives.join(' · ')}</Text>}
    </Box>
  );
}

function NoSearchMatches({
  status,
  query,
  hidden,
}: {
  status: JobStatus;
  query: string;
  hidden: number;
}) {
  return (
    <Box flexDirection="column" alignItems="center" marginTop={2}>
      <Text color={statusColor(status)}>◌ No matches for "{query}"</Text>
      <Text dimColor>
        {hidden === 1
          ? `The one ${status} job on this page doesn't match.`
          : `None of the ${hidden} ${status} jobs on this page match.`}
      </Text>
      {/*
        Not a bare "press Esc": in the jobs view Escape pops back to the
        queue list (`useKeymap`'s `handleJobsInput`) and leaves the query
        applied. Reopening the input with `/` is what puts Escape back in
        reach of `closeSearch`.
      */}
      <Text dimColor>Press / then Esc to clear it.</Text>
    </Box>
  );
}

function LoadingJobs({ status }: { status: JobStatus }) {
  return (
    <Box flexDirection="column" alignItems="center" marginTop={2}>
      <Text dimColor>Loading {status} jobs…</Text>
    </Box>
  );
}

/** Full-width, single-focus job table. */
export function JobTable({
  jobs,
  status = 'active',
  selectedJobId,
  page,
  pageCount,
  width,
  counts,
  loading = false,
  hiddenBySearch = 0,
  searchQuery = '',
}: JobTableProps) {
  return (
    <Box flexDirection="column">
      {/*
        `flexShrink={0}`: when the view is taller than the terminal the overflow
        is pushed into this table (see `Header`), and Yoga would otherwise clip
        from the top — taking the column labels first and leaving unlabelled
        rows. Losing a job row is the better trade; the rest stays paginated.
      */}
      <Box flexShrink={0}>
        <Text bold>{headerLine(width)}</Text>
      </Box>
      {jobs.length === 0 ? (
        // Order matters: a page that hasn't arrived yet can't be said to
        // match nothing, so loading wins over the no-matches state, which
        // in turn wins over "this status is empty" (it isn't — the query is
        // just hiding every row).
        loading ? (
          <LoadingJobs status={status} />
        ) : hiddenBySearch > 0 ? (
          <NoSearchMatches status={status} query={searchQuery} hidden={hiddenBySearch} />
        ) : (
          <EmptyJobs status={status} counts={counts} />
        )
      ) : (
        <>
          {jobs.map((job) => {
            const isSelected = job.id === selectedJobId;
            return (
              <Text key={job.id} inverse={isSelected} bold={isSelected}>
                {rowLine(job, status, isSelected, width)}
              </Text>
            );
          })}
          <Box justifyContent="flex-end" marginTop={1}>
            <Text dimColor>
              Page {page + 1} of {pageCount}
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}

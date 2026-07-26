import { Box, Text } from 'ink';
import { formatClock } from '../core/format.js';
import type { JobSummary } from '../core/types.js';

export interface JobTableProps {
  jobs: JobSummary[];
  status?: string;
  selectedJobId: string | null;
  /** 0-based current page (matches `DashboardSnapshot.page`/`JobPage.page`). */
  page: number;
  pageCount: number;
  /** Current terminal width; columns shrink predictably at narrow sizes. */
  width?: number;
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
  if (width === undefined || width >= 82) {
    return { id: ID_WIDTH, created: TIMESTAMP_WIDTH, name: NAME_WIDTH };
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

/** Full-width, single-focus job table. */
export function JobTable({
  jobs,
  status = '—',
  selectedJobId,
  page,
  pageCount,
  width,
}: JobTableProps) {
  return (
    <Box flexDirection="column">
      <Text bold>{headerLine(width)}</Text>
      {jobs.length === 0 ? (
        <Text dimColor>No jobs</Text>
      ) : (
        jobs.map((job) => {
          const isSelected = job.id === selectedJobId;
          return (
            <Text key={job.id} inverse={isSelected} bold={isSelected}>
              {rowLine(job, status, isSelected, width)}
            </Text>
          );
        })
      )}
      <Box justifyContent="flex-end">
        <Text dimColor>
          Page {page + 1} of {pageCount}
        </Text>
      </Box>
    </Box>
  );
}

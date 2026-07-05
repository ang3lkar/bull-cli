import { Box, Text } from 'ink';
import { formatClock } from '../core/format.js';
import type { JobSummary } from '../core/types.js';

export interface JobTableProps {
  jobs: JobSummary[];
  selectedJobId: string | null;
  /** 0-based current page (matches `DashboardSnapshot.page`/`JobPage.page`). */
  page: number;
  pageCount: number;
  focused: boolean;
  /** Injected clock; currently unused (the Timestamp column is absolute via `formatClock`, not relative) but kept on the prop surface for the Phase 8 caller. */
  now: number;
}

const ID_WIDTH = 10;
const NAME_WIDTH = 16;
const ATTEMPTS_WIDTH = 8;
const TIMESTAMP_WIDTH = 19; // `formatClock` always produces exactly 19 chars.
const PROGRESS_WIDTH = 8;

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

function selectionMarker(isSelected: boolean, focused: boolean): string {
  if (!isSelected) {
    return '  ';
  }
  return focused ? '❯ ' : '· ';
}

function progressLabel(progress: number | null): string {
  return progress === null ? '—' : `${progress}%`;
}

function headerLine(): string {
  return [
    '  ',
    cell('ID', ID_WIDTH),
    cell('Name', NAME_WIDTH),
    cell('Attempts', ATTEMPTS_WIDTH),
    cell('Timestamp', TIMESTAMP_WIDTH),
    cell('Progress', PROGRESS_WIDTH),
  ].join(' ');
}

function rowLine(job: JobSummary, isSelected: boolean, focused: boolean): string {
  return [
    selectionMarker(isSelected, focused),
    cell(job.id, ID_WIDTH),
    cell(job.name, NAME_WIDTH),
    cell(String(job.attemptsMade), ATTEMPTS_WIDTH),
    cell(formatClock(job.timestamp), TIMESTAMP_WIDTH),
    cell(progressLabel(job.progress), PROGRESS_WIDTH),
  ].join(' ');
}

/** Job list table: ID | Name | Attempts | Timestamp | Progress, plus a bottom-right page indicator. Rows/pages already come pre-filtered/paginated from the store — purely presentational. */
export function JobTable({ jobs, selectedJobId, page, pageCount, focused }: JobTableProps) {
  return (
    <Box flexDirection="column">
      <Text bold>{headerLine()}</Text>
      {jobs.length === 0 ? (
        <Text dimColor>No jobs</Text>
      ) : (
        jobs.map((job) => {
          const isSelected = job.id === selectedJobId;
          return (
            <Text key={job.id} inverse={isSelected && focused} bold={isSelected}>
              {rowLine(job, isSelected, focused)}
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

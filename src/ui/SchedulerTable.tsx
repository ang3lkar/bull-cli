import { Box, Text } from 'ink';
import { formatIterations, formatRelativeNext, formatSchedule } from '../core/format.js';
import type { SchedulerSummary } from '../core/types.js';

export interface SchedulerTableProps {
  schedulers: SchedulerSummary[];
  selectedKey: string | null;
  /** 0-based current page (matches `DashboardSnapshot.page`). */
  page: number;
  pageCount: number;
  /** Current terminal width; the Key column absorbs the slack. */
  width?: number;
  /** `true` while the page is still being fetched, so an empty list isn't "nothing here". */
  loading?: boolean;
  /** Short terminal: drop the blank row above the page indicator. */
  compact?: boolean;
  /** Clock for the relative `Next run` column, injectable for tests. */
  now?: number;
}

const NAME_WIDTH = 14;
const SCHEDULE_WIDTH = 16;
const TZ_WIDTH = 14;
const NEXT_WIDTH = 9;
const ITERATIONS_WIDTH = 10;
const COL_GAP = '  ';
/** Marker + the five fixed columns + six gaps. */
const FIXED_WIDTH = 2 + NAME_WIDTH + SCHEDULE_WIDTH + TZ_WIDTH + NEXT_WIDTH + ITERATIONS_WIDTH + 12;
const DEFAULT_KEY_WIDTH = 24;

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

function rightCell(value: string, width: number): string {
  return truncate(value, width).padStart(width);
}

function keyWidth(width: number | undefined): number {
  if (width === undefined) {
    return DEFAULT_KEY_WIDTH;
  }
  return Math.min(36, Math.max(8, width - FIXED_WIDTH));
}

function headerLine(width: number | undefined): string {
  return [
    '  ',
    cell('Key', keyWidth(width)),
    cell('Name', NAME_WIDTH),
    cell('Schedule', SCHEDULE_WIDTH),
    cell('TZ', TZ_WIDTH),
    cell('Next run', NEXT_WIDTH),
    rightCell('Iterations', ITERATIONS_WIDTH),
  ].join(COL_GAP);
}

function rowLine(
  scheduler: SchedulerSummary,
  isSelected: boolean,
  width: number | undefined,
  now: number,
): string {
  return [
    isSelected ? '❯ ' : '  ',
    cell(scheduler.key, keyWidth(width)),
    cell(scheduler.name, NAME_WIDTH),
    cell(formatSchedule(scheduler), SCHEDULE_WIDTH),
    cell(scheduler.tz ?? '—', TZ_WIDTH),
    cell(formatRelativeNext(scheduler.next, now), NEXT_WIDTH),
    rightCell(formatIterations(scheduler.iterationCount, scheduler.limit), ITERATIONS_WIDTH),
  ].join(COL_GAP);
}

/** Full-width table of a queue's job schedulers, soonest-running first. */
export function SchedulerTable({
  schedulers,
  selectedKey,
  page,
  pageCount,
  width,
  loading = false,
  compact = false,
  now = Date.now(),
}: SchedulerTableProps) {
  return (
    // `flexShrink={0}`: in a short terminal the table area clips this box at
    // its bottom edge rather than letting Yoga squeeze rows out of the middle.
    <Box flexDirection="column" flexShrink={0}>
      <Box flexShrink={0}>
        <Text bold>{headerLine(width)}</Text>
      </Box>
      {schedulers.length === 0 ? (
        <Box flexDirection="column" alignItems="center" marginTop={2}>
          {loading ? (
            <Text dimColor>Loading job schedulers…</Text>
          ) : (
            <>
              <Text dimColor>◌ No job schedulers</Text>
              <Text dimColor>This queue has no repeatable jobs.</Text>
            </>
          )}
        </Box>
      ) : (
        <>
          {schedulers.map((scheduler) => {
            const isSelected = scheduler.key === selectedKey;
            return (
              <Text key={scheduler.key} inverse={isSelected} bold={isSelected}>
                {rowLine(scheduler, isSelected, width, now)}
              </Text>
            );
          })}
          <Box justifyContent="flex-end" marginTop={compact ? 0 : 1}>
            <Text dimColor>
              Page {page + 1} of {pageCount}
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}

import { Box, Text } from 'ink';
import { formatRate, type QueueTotals, type Throughput } from '../core/throughput.js';

export interface QueueMetricsProps {
  totals: QueueTotals;
  /** `null` until two refreshes have landed; renders as `—`. */
  throughput: Throughput | null;
  /** Available columns; picks the longest layout that fits. Unknown means the longest. */
  width?: number;
}

interface Segment {
  text: string;
  color?: string;
  dim?: boolean;
}

interface Labels {
  total: string;
  throughput: string;
  sep: string;
  delayed: string;
  waiting: string;
  active: string;
  failed: string;
}

const FULL: Labels = {
  total: 'Total ',
  throughput: 'Throughput ',
  sep: ' · ',
  delayed: 'delayed',
  waiting: 'waiting',
  active: 'active',
  failed: 'failed',
};
const MEDIUM: Labels = { ...FULL, throughput: '' };
const COMPACT: Labels = {
  total: 'All ',
  throughput: '',
  sep: ' · ',
  delayed: 'dly',
  waiting: 'wait',
  active: 'act',
  failed: 'fail',
};
const TIGHT: Labels = { ...COMPACT, total: '', sep: ' ' };

function rate(perMin: number | undefined): string {
  return perMin === undefined ? '—' : `${formatRate(perMin)}/min`;
}

function layout(totals: QueueTotals, throughput: Throughput | null, l: Labels): Segment[] {
  const label = (text: string): Segment[] => (text === '' ? [] : [{ text, dim: true }]);
  return [
    ...label(l.total),
    { text: String(totals.delayed), color: 'yellow' },
    { text: ` ${l.delayed}${l.sep}`, dim: true },
    { text: String(totals.waiting), color: 'yellow' },
    { text: ` ${l.waiting}${l.sep}`, dim: true },
    { text: String(totals.active), color: 'cyan' },
    { text: ` ${l.active}${l.sep}`, dim: true },
    { text: String(totals.failed), color: 'red' },
    { text: ` ${l.failed}${l.sep}`, dim: true },
    { text: String(totals.completed) },
    { text: ' done   ', dim: true },
    ...label(l.throughput),
    { text: rate(throughput?.completedPerMin) },
    { text: ` done${l.sep}`, dim: true },
    { text: rate(throughput?.failedPerMin), color: 'red' },
    { text: ` ${l.failed}`, dim: true },
  ];
}

const length = (segments: Segment[]) => segments.reduce((sum, s) => sum + s.text.length, 0);

/**
 * One-line metrics row above the queue table: job totals across every queue,
 * then completed and failed jobs per minute. Always rendered and never
 * wrapped, so the table below it doesn't move when the rate appears or the
 * terminal is narrow. Labels shorten before anything is cut off; only a very
 * narrow terminal truncates the end.
 */
export function QueueMetrics({ totals, throughput, width }: QueueMetricsProps) {
  const layouts = [FULL, MEDIUM, COMPACT, TIGHT].map((labels) =>
    layout(totals, throughput, labels),
  );
  const segments =
    width === undefined
      ? layouts[0]
      : (layouts.find((candidate) => length(candidate) <= width) ?? layouts[layouts.length - 1]);
  return (
    <Box flexShrink={0}>
      <Text wrap="truncate-end">
        {segments.map((segment, index) => (
          <Text
            // Segments are positional and never reorder.
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-order layout
            key={index}
            color={segment.color}
            dimColor={segment.dim}
          >
            {segment.text}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

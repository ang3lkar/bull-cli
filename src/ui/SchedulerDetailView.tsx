import { Box, Text } from 'ink';
import {
  formatClock,
  formatIterations,
  formatRelativeNext,
  formatSchedule,
} from '../core/format.js';
import type { SchedulerDetail } from '../core/types.js';
import { LEFT_COLUMN_WIDTH, MetaRow, prettyJson } from './JobDetailView.js';

export interface SchedulerDetailViewProps {
  detail: SchedulerDetail;
  queueName?: string;
  /** Clock for the relative next-run line, injectable for tests. */
  now?: number;
}

function clockOrDash(ms: number | null): string {
  return ms === null ? '—' : formatClock(ms);
}

/**
 * Two-column, read-only scheduler detail: schedule metadata on the left, the
 * job template (`data` and `opts`) as JSON on the right. Shares its layout
 * pieces with `JobDetailView`.
 */
export function SchedulerDetailView({
  detail,
  queueName,
  now = Date.now(),
}: SchedulerDetailViewProps) {
  return (
    <Box borderStyle="round" flexDirection="row" paddingX={1} overflow="hidden">
      <Box flexDirection="column" width={LEFT_COLUMN_WIDTH} flexShrink={0} marginRight={2}>
        <Box flexDirection="column" flexShrink={0}>
          <MetaRow label="Key" value={detail.key} />
          <MetaRow label="Name" value={detail.name} />
          {queueName !== undefined && <MetaRow label="Queue" value={queueName} />}
          <MetaRow label="Schedule" value={formatSchedule(detail)} />
          <MetaRow label="Timezone" value={detail.tz ?? '—'} />
          <MetaRow label="Next run" value={clockOrDash(detail.next)} />
          <MetaRow label="Next in" value={formatRelativeNext(detail.next, now)} />
          <MetaRow label="Start date" value={clockOrDash(detail.startDate)} />
          <MetaRow label="End date" value={clockOrDash(detail.endDate)} />
          <MetaRow
            label="Iterations"
            value={formatIterations(detail.iterationCount, detail.limit)}
          />
          <MetaRow label="Offset" value={detail.offset === null ? '—' : `${detail.offset}ms`} />
          {/* Its own block: the id (`repeat:<key>:<millis>`) is too long for a label row. */}
          <Box flexDirection="column" marginTop={1}>
            <Text>Next job:</Text>
            <Text>{detail.nextJobId ?? '—'}</Text>
            {detail.nextJobId !== null && <Text dimColor>Enter opens the next job</Text>}
          </Box>
        </Box>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        <Box flexDirection="column" flexShrink={0}>
          <Text bold>Template data</Text>
          <Text>{prettyJson(detail.template.data)}</Text>
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Template opts</Text>
            <Text>{prettyJson(detail.template.opts)}</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

import { Box, Text } from 'ink';
import type { QueueCounts } from '../core/store.js';
import type { QueueInfo } from '../core/types.js';

export interface QueueTableProps {
  queues: QueueInfo[];
  counts: Readonly<Record<string, QueueCounts>>;
  selectedName: string | null;
  width?: number;
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}

function queueWidth(width: number | undefined): number {
  return Math.max(16, (width ?? 100) - 51);
}

function Count({
  value,
  color,
  dim,
  selected,
}: {
  value: number;
  color?: string;
  dim?: boolean;
  selected: boolean;
}) {
  return (
    <Box width={9} justifyContent="flex-end">
      <Text color={color} dimColor={dim} inverse={selected} bold={selected}>
        {value}
      </Text>
    </Box>
  );
}

/** Full-width queue table for the root of the navigation stack. */
export function QueueTable({ queues, counts, selectedName, width }: QueueTableProps) {
  const nameWidth = queueWidth(width);

  return (
    <Box flexDirection="column">
      <Box>
        <Box width={nameWidth + 2} />
        <Box width={9} justifyContent="flex-end">
          <Text bold color="yellow">
            Delayed
          </Text>
        </Box>
        <Box width={9} justifyContent="flex-end">
          <Text bold>Waiting</Text>
        </Box>
        <Box width={9} justifyContent="flex-end">
          <Text bold color="cyan">
            Active
          </Text>
        </Box>
        <Box width={9} justifyContent="flex-end">
          <Text bold color="red">
            Failed
          </Text>
        </Box>
        <Box width={9} justifyContent="flex-end">
          <Text bold dimColor>
            Done
          </Text>
        </Box>
      </Box>
      {queues.map((queue) => {
        const selected = queue.name === selectedName;
        const queueCounts = counts[queue.name];
        return (
          <Box key={queue.name}>
            <Box width={nameWidth + 2}>
              <Text inverse={selected} bold={selected}>
                {selected ? '❯ ' : '  '}
                {truncate(`${queue.name}${queue.isPaused ? ' ⏸' : ''}`, nameWidth)}
              </Text>
            </Box>
            <Count value={queueCounts?.delayed ?? 0} color="yellow" selected={selected} />
            <Count value={queueCounts?.waiting ?? 0} color="yellow" selected={selected} />
            <Count value={queueCounts?.active ?? 0} color="cyan" selected={selected} />
            <Count value={queueCounts?.failed ?? 0} color="red" selected={selected} />
            <Count value={queueCounts?.completed ?? 0} dim selected={selected} />
          </Box>
        );
      })}
    </Box>
  );
}

import { Box, Text } from 'ink';
import { maskRedisUrl } from '../core/format.js';

export interface EmptyStateProps {
  url: string;
}

/** Shown when discovery finds no BullMQ queues at all: `No BullMQ queues found on <url>` (password-masked). */
export function EmptyState({ url }: EmptyStateProps) {
  return (
    <Box alignItems="center" justifyContent="center" width="100%">
      <Text>No BullMQ queues found on {maskRedisUrl(url)}</Text>
    </Box>
  );
}

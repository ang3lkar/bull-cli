import { Box, Text } from 'ink';
import { maskRedisUrl } from '../core/format.js';

export interface LoadingProps {
  url: string;
}

/**
 * Shown while the first refresh cycle is still in flight, i.e. before
 * discovery has told us whether this Redis has any BullMQ queues at all
 * (see `DashboardSnapshot.initialLoadComplete`). Without it, a slow or
 * large instance renders `EmptyState`'s "No BullMQ queues found" for
 * seconds, which reads as a definitive (and wrong) answer. URL is
 * password-masked, like every other on-screen URL.
 */
export function Loading({ url }: LoadingProps) {
  return (
    <Box alignItems="center" justifyContent="center" width="100%">
      <Text dimColor>Discovering queues on {maskRedisUrl(url)}…</Text>
    </Box>
  );
}

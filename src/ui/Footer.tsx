import { Box, Text } from 'ink';
import { maskRedisUrl } from '../core/format.js';

export interface FooterProps {
  redisUrl: string;
  /** BullMQ key prefix the dashboard is reading queues under. */
  prefix: string;
}

/**
 * Bottom status bar: the connection this dashboard is pointed at on the left,
 * and the BullMQ key prefix on the right. Two apps can share one Redis under
 * different prefixes, so the URL alone doesn't say which queues these are.
 */
export function Footer({ redisUrl, prefix }: FooterProps) {
  return (
    <Box justifyContent="space-between">
      <Text>{maskRedisUrl(redisUrl)}</Text>
      <Text>
        <Text dimColor>prefix </Text>
        {prefix}
      </Text>
    </Box>
  );
}

import { Box, Text } from 'ink';
import { maskRedisUrl, relativeTime } from '../core/format.js';

export interface FooterProps {
  redisUrl: string;
  lastUpdatedAt: number | null;
  now: number;
}

/** Bottom status bar with connection and refresh information. */
export function Footer({ redisUrl, lastUpdatedAt, now }: FooterProps) {
  const updated =
    lastUpdatedAt === null
      ? 'Last updated: —'
      : `Last updated: ${relativeTime(lastUpdatedAt, now)}`;

  return (
    <Box justifyContent="space-between">
      <Text>{maskRedisUrl(redisUrl)}</Text>
      <Text>{updated}</Text>
    </Box>
  );
}

import { Box, Text } from 'ink';
import { maskRedisUrl, relativeTime } from '../core/format.js';

export interface FooterProps {
  redisUrl: string;
  lastUpdatedAt: number | null;
  now: number;
}

const KEY_HINTS = '/ search  R refresh  q quit';

/** Bottom bar: masked Redis URL (left), "Last updated: Ns ago" (center), key hints (right). */
export function Footer({ redisUrl, lastUpdatedAt, now }: FooterProps) {
  const updated =
    lastUpdatedAt === null
      ? 'Last updated: —'
      : `Last updated: ${relativeTime(lastUpdatedAt, now)}`;

  return (
    <Box justifyContent="space-between">
      <Text>{maskRedisUrl(redisUrl)}</Text>
      <Text>{updated}</Text>
      <Text dimColor>{KEY_HINTS}</Text>
    </Box>
  );
}

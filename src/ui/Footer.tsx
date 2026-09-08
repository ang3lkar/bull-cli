import { Box, Text } from 'ink';
import { maskRedisUrl } from '../core/format.js';

export interface FooterProps {
  redisUrl: string;
}

/** Bottom status bar: the connection this dashboard is pointed at. */
export function Footer({ redisUrl }: FooterProps) {
  return (
    <Box>
      <Text>{maskRedisUrl(redisUrl)}</Text>
    </Box>
  );
}

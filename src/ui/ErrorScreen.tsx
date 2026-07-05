import { Box, Text } from 'ink';
import { maskRedisUrl } from '../core/format.js';

export interface ErrorScreenProps {
  url: string;
  message: string;
}

/**
 * Full-screen error view shown when Redis is unreachable: the attempted
 * (password-masked) connection string, a human-readable message, and a
 * hint — deliberately NO raw stack trace (the store already normalizes
 * connection errors into a plain message; this component never renders
 * anything beyond that).
 */
export function ErrorScreen({ url, message }: ErrorScreenProps) {
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" width="100%">
      <Text bold color="red">
        Cannot connect to Redis
      </Text>
      <Text>{maskRedisUrl(url)}</Text>
      <Text>{message}</Text>
      <Text dimColor>Check the connection or pass --redis {'<url>'}</Text>
    </Box>
  );
}

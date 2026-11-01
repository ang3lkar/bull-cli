import { Box, Text } from 'ink';
import { connectionFromUrl } from '../config.js';
import { maskRedisUrl, withRedisDb } from '../core/format.js';

export interface EmptyStateProps {
  url: string;
  prefix: string;
}

function dbFromUrl(url: string): number {
  try {
    const { db } = connectionFromUrl(url);
    return Number.isNaN(db) ? 0 : db;
  } catch {
    return 0;
  }
}

/**
 * Shown when discovery finds no BullMQ queues: names the prefix and DB that
 * were searched and points at the two usual causes (wrong prefix, wrong
 * logical DB). The URL is always password-masked.
 */
export function EmptyState({ url, prefix }: EmptyStateProps) {
  const masked = maskRedisUrl(url);
  const db = dbFromUrl(url);
  const exampleUrl = withRedisDb(masked, db === 1 ? 0 : 1);
  return (
    <Box alignItems="center" justifyContent="center" width="100%" flexDirection="column">
      <Text>
        No BullMQ queues found under prefix "{prefix}" in DB {db} on {masked}
      </Text>
      <Text>Custom prefix? Pass --prefix {'<prefix>'} or set BULLMQ_PREFIX.</Text>
      <Text>Queues in another database? Put it in the URL, e.g. {exampleUrl}</Text>
      <Text>Run `bull-cli doctor` for a full diagnosis.</Text>
    </Box>
  );
}

import { Box, Text } from 'ink';
import type { NavigationView } from '../core/store.js';

export interface HeaderProps {
  /** App version, taken from package.json at startup (e.g. `0.1.0`). */
  version: string;
  view?: NavigationView;
}

/**
 * Top title bar: the app name and version (`bull-cli - v0.1.0`), with a
 * bottom rule separating it from the rest of the screen. Ink can't draw a
 * lone bottom border, so it's a single-style box with the other three sides
 * switched off — leaving just the horizontal line under the title.
 */
export function Header({ version, view }: HeaderProps) {
  const viewLabel =
    view?.kind === 'jobs'
      ? `Queue: ${view.queueName}`
      : view?.kind === 'detail'
        ? `Job: ${view.jobId}`
        : 'Queues';
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="single" borderTop={false} borderLeft={false} borderRight={false}>
        <Text bold>bull-cli</Text>
        <Text dimColor> - v{version} </Text>
        <Text color="cyan">{viewLabel}</Text>
      </Box>
      <Text dimColor>
        <Text color="yellow">↑↓</Text> move <Text color="cyan">Enter</Text> open{' '}
        <Text color="yellow">Esc/h</Text> back <Text color="cyan">/</Text> filter{' '}
        <Text color="yellow">r</Text> refresh <Text color="red">q</Text> quit
      </Text>
    </Box>
  );
}

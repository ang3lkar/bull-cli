import { Box, Text } from 'ink';
import type { QueueInfo } from '../core/types.js';

export interface SidebarProps {
  queues: QueueInfo[];
  selectedName: string | null;
  focused: boolean;
}

/**
 * Marker prefix that carries BOTH selection and focus state as text (Ink's
 * `lastFrame()` drops color/inverse styling, so the distinction between "the
 * job list is focused" and "it isn't" has to be observable as different
 * characters, not just a different color): selected-and-focused gets `❯ `,
 * selected-but-unfocused gets `· ` (you can still see what's selected when
 * focus moves away), and unselected rows get two blank spaces to keep
 * columns aligned.
 */
function selectionMarker(isSelected: boolean, focused: boolean): string {
  if (!isSelected) {
    return '  ';
  }
  return focused ? '❯ ' : '· ';
}

/** Sorted queue list with a `(paused)` label and selection/focus indicators. Purely presentational — sorting is the store's job. */
export function Sidebar({ queues, selectedName, focused }: SidebarProps) {
  if (queues.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No queues</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {queues.map((queue) => {
        const isSelected = queue.name === selectedName;
        const marker = selectionMarker(isSelected, focused);
        const label = `${marker}${queue.name}${queue.isPaused ? ' (paused)' : ''}`;
        return (
          <Text key={queue.name} inverse={isSelected && focused} bold={isSelected}>
            {label}
          </Text>
        );
      })}
    </Box>
  );
}

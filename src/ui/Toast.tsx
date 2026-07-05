import { Box, Text } from 'ink';
import type { Toast as ToastEntry } from '../core/types.js';

export interface ToastProps {
  toasts: ToastEntry[];
}

/** Ephemeral inline notifications (e.g. a failed job action) stacked at the bottom of the screen, visually distinct via color. Renders nothing when there are none. */
export function Toast({ toasts }: ToastProps) {
  if (toasts.length === 0) {
    return null;
  }
  return (
    <Box flexDirection="column">
      {toasts.map((toast) => (
        <Text key={toast.id} color="yellow" bold>
          {toast.message}
        </Text>
      ))}
    </Box>
  );
}

import { Text } from 'ink';
import type { JobStatus } from '../core/types.js';

export interface TabsProps {
  active: JobStatus;
  /** Per-tab job counts, e.g. `Waiting (15)`. Bare labels render when omitted/null. */
  counts?: Record<JobStatus, number> | null;
}

/** Tab order/labels, matching the spec's `1`-`5` key bindings. */
const TAB_ORDER: JobStatus[] = ['active', 'waiting', 'completed', 'failed', 'delayed'];

const TAB_LABELS: Record<JobStatus, string> = {
  active: 'Active',
  waiting: 'Waiting',
  completed: 'Completed',
  failed: 'Failed',
  delayed: 'Delayed',
};

/** Status tab row: `Active | Waiting | Completed | Failed | Delayed` with the active tab bracketed/highlighted, and an optional `(count)` suffix per tab. */
export function Tabs({ active, counts }: TabsProps) {
  return (
    <Text>
      {TAB_ORDER.map((status, index) => {
        const isActive = status === active;
        const label = TAB_LABELS[status];
        const suffix = counts != null ? ` (${counts[status]})` : '';
        return (
          <Text key={status}>
            <Text bold={isActive} inverse={isActive}>
              {isActive ? `[${label}]` : label}
              {suffix}
            </Text>
            {index < TAB_ORDER.length - 1 ? ' | ' : ''}
          </Text>
        );
      })}
    </Text>
  );
}

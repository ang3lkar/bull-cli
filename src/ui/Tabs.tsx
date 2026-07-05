import { Text } from 'ink';
import type { JobStatus } from '../core/types.js';

export interface TabsProps {
  active: JobStatus;
}

/** Tab order/labels, matching the spec's `1`-`5` key bindings. No job counts (per plan: the store snapshot has none, and the spec's tab row shows names only). */
const TAB_ORDER: JobStatus[] = ['active', 'waiting', 'completed', 'failed', 'delayed'];

const TAB_LABELS: Record<JobStatus, string> = {
  active: 'Active',
  waiting: 'Waiting',
  completed: 'Completed',
  failed: 'Failed',
  delayed: 'Delayed',
};

/** Status tab row: `Active | Waiting | Completed | Failed | Delayed` with the active tab bracketed/highlighted. */
export function Tabs({ active }: TabsProps) {
  return (
    <Text>
      {TAB_ORDER.map((status, index) => {
        const isActive = status === active;
        const label = TAB_LABELS[status];
        return (
          <Text key={status}>
            <Text bold={isActive} inverse={isActive}>
              {isActive ? `[${label}]` : label}
            </Text>
            {index < TAB_ORDER.length - 1 ? ' | ' : ''}
          </Text>
        );
      })}
    </Text>
  );
}

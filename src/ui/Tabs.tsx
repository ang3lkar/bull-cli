import { Text } from 'ink';
import type { JobStatus } from '../core/types.js';

export interface TabsProps {
  active: JobStatus;
  /**
   * Per-tab job counts. Each tab always reserves a fixed-width, 6-character
   * count slot, right-aligned with the closing `)` fixed in place and the
   * content tightly wrapped in parens (e.g. `(15)`, `(~4k)`) so the row
   * never shifts as counts load or change width. When omitted/null (counts
   * still loading), the slot renders as blank spaces of the same width
   * instead of a count.
   */
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

/**
 * Width of the fixed count slot: the `(count)` group is left-padded to this
 * width so the closing `)` (and every label after it) never moves. Longest
 * realistic content is `(999k)`/`(999m)` (6 chars), which fills the slot
 * exactly with zero guaranteed leading space at 3-digit mantissas.
 */
const COUNT_SLOT_WIDTH = 6;
const BLANK_COUNT_SLOT = ' '.repeat(COUNT_SLOT_WIDTH);

/**
 * Formats a non-negative job count into a string of at most 4 characters,
 * assuming counts stay below 1e9 (a single bullmq status bucket cannot
 * realistically hold a billion jobs). A leading `~` marks abbreviated
 * (floored) values, but is dropped when a 3-digit mantissa would otherwise
 * exceed the 4-character budget (e.g. `999k`, not `~999k`).
 */
export function formatCount(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  const s = n < 1_000_000 ? `${Math.floor(n / 1000)}k` : `${Math.floor(n / 1_000_000)}m`;
  return s.length <= 3 ? `~${s}` : s;
}

/**
 * Status tab row: `Active | Waiting | Completed | Failed | Delayed` with the
 * active tab bracketed/highlighted. For the active tab, the bold+inverse
 * highlight covers the whole cell — both the `[Label]` marker and its count
 * slot (e.g. `[Active](999k)`) — while inactive tabs render unstyled. Each
 * cell is positionally stable: the active marker (`[Label]` vs ` Label `) is
 * width-neutral, and every tab reserves a fixed-width, right-aligned count
 * slot (tight parens, e.g. `(15)`/`(~4k)`, padded on the left) regardless of
 * whether counts have loaded yet or how many digits they contain.
 */
export function Tabs({ active, counts }: TabsProps) {
  return (
    <Text>
      {TAB_ORDER.map((status, index) => {
        const isActive = status === active;
        const label = TAB_LABELS[status];
        const marker = isActive ? `[${label}]` : ` ${label} `;
        const countSlot =
          counts != null
            ? `(${formatCount(counts[status])})`.padStart(COUNT_SLOT_WIDTH)
            : BLANK_COUNT_SLOT;
        return (
          <Text key={status}>
            <Text bold={isActive} inverse={isActive}>
              {marker}
              {countSlot}
            </Text>
            {index < TAB_ORDER.length - 1 ? ' | ' : ''}
          </Text>
        );
      })}
    </Text>
  );
}

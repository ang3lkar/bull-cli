import { Box, Text } from 'ink';
import type { NavigationView, QueueSort } from '../core/store.js';
import type { Tab } from '../core/types.js';

export interface BreadcrumbProps {
  view: NavigationView;
  /**
   * The status tab the job list is on. Shown as its own crumb in the detail
   * view, since that's the list the job was opened from (and `Esc` returns to).
   */
  status?: Tab;
  /**
   * The scheduler a job detail was opened from (the `scheduler` view below it
   * in the navigation stack), so the trail reads `… > schedulers > <key> > job #id`.
   */
  schedulerKey?: string;
  /** Queue list sort, shown as a dim suffix on the root crumb (`Queues · sorted by failed`). */
  sort?: QueueSort;
}

interface Crumb {
  /** Stack level, not text: a queue may legitimately be named `Queues`. */
  level: 'root' | 'queue' | 'status' | 'scheduler' | 'job';
  label: string;
}

/** One crumb per level of the navigation stack, outermost first. */
function crumbsFor(
  view: NavigationView,
  status: Tab | undefined,
  schedulerKey: string | undefined,
): Crumb[] {
  const root: Crumb = { level: 'root', label: 'Queues' };
  switch (view.kind) {
    case 'jobs':
      return [
        root,
        { level: 'queue', label: view.queueName },
        // The job tabs are shown by the tab row; only Schedulers needs a crumb.
        ...(status === 'schedulers' ? [{ level: 'status', label: status } as const] : []),
      ];
    case 'scheduler':
      return [
        root,
        { level: 'queue', label: view.queueName },
        { level: 'status', label: 'schedulers' },
        { level: 'scheduler', label: view.key },
      ];
    case 'detail':
      return [
        root,
        { level: 'queue', label: view.queueName },
        ...(status === undefined ? [] : [{ level: 'status', label: status } as const]),
        ...(schedulerKey === undefined
          ? []
          : [{ level: 'scheduler', label: schedulerKey } as const]),
        { level: 'job', label: `job #${view.jobId}` },
      ];
    default:
      return [root];
  }
}

/**
 * The body's location line: `Queues > emailQ > failed > job #43`, one crumb
 * per level of the navigation stack (plus the status tab the job was opened
 * from, in the detail view), with the current level highlighted.
 *
 * Location lives here rather than in the title bar, which is app chrome and
 * says nothing about where you are (see `CONTEXT.md`).
 */
export function Breadcrumb({ view, status, schedulerKey, sort }: BreadcrumbProps) {
  const crumbs = crumbsFor(view, status, schedulerKey);
  const current = crumbs[crumbs.length - 1];
  return (
    <Box>
      {crumbs.map((crumb) => (
        <Text key={crumb.level}>
          {crumb.level !== 'root' && <Text dimColor> &gt; </Text>}
          <Text bold={crumb === current} color={crumb === current ? 'cyan' : undefined}>
            {crumb.label}
          </Text>
        </Text>
      ))}
      {sort !== undefined && view.kind === 'queues' && <Text dimColor> · sorted by {sort}</Text>}
    </Box>
  );
}

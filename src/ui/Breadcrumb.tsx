import { Box, Text } from 'ink';
import type { NavigationView } from '../core/store.js';
import type { JobStatus } from '../core/types.js';

export interface BreadcrumbProps {
  view: NavigationView;
  /**
   * The status tab the job list is on. Shown as its own crumb in the detail
   * view, since that's the list the job was opened from (and `Esc` returns to).
   */
  status?: JobStatus;
}

interface Crumb {
  /** Stack level, not text: a queue may legitimately be named `Queues`. */
  level: 'root' | 'queue' | 'status' | 'job';
  label: string;
}

/** One crumb per level of the navigation stack, outermost first. */
function crumbsFor(view: NavigationView, status: JobStatus | undefined): Crumb[] {
  const root: Crumb = { level: 'root', label: 'Queues' };
  switch (view.kind) {
    case 'jobs':
      return [root, { level: 'queue', label: view.queueName }];
    case 'detail':
      return [
        root,
        { level: 'queue', label: view.queueName },
        ...(status === undefined ? [] : [{ level: 'status', label: status } as const]),
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
export function Breadcrumb({ view, status }: BreadcrumbProps) {
  const crumbs = crumbsFor(view, status);
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
    </Box>
  );
}

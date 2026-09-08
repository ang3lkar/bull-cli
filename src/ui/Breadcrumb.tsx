import { Box, Text } from 'ink';
import type { NavigationView } from '../core/store.js';

export interface BreadcrumbProps {
  view: NavigationView;
}

interface Crumb {
  /** Stack level, not text: a queue may legitimately be named `Queues`. */
  level: 'root' | 'queue' | 'job';
  label: string;
}

/** One crumb per level of the navigation stack, outermost first. */
function crumbsFor(view: NavigationView): Crumb[] {
  const root: Crumb = { level: 'root', label: 'Queues' };
  switch (view.kind) {
    case 'jobs':
      return [root, { level: 'queue', label: view.queueName }];
    case 'detail':
      return [
        root,
        { level: 'queue', label: view.queueName },
        { level: 'job', label: `job #${view.jobId}` },
      ];
    default:
      return [root];
  }
}

/**
 * The body's location line: `Queues > emailQ > job #43`, one crumb per level
 * of the navigation stack, with the current level highlighted.
 *
 * Location lives here rather than in the title bar, which is app chrome and
 * says nothing about where you are (see `CONTEXT.md`).
 */
export function Breadcrumb({ view }: BreadcrumbProps) {
  const crumbs = crumbsFor(view);
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

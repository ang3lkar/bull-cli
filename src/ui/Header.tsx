import { Box, Text } from 'ink';
import type { NavigationView } from '../core/store.js';
import type { JobStatus } from '../core/types.js';

export interface HeaderProps {
  /** App version, taken from package.json at startup (e.g. `0.1.0`). */
  version: string;
  view?: NavigationView;
  status?: JobStatus;
}

interface Shortcut {
  key: string;
  label: string;
}

const GLOBAL_SHORTCUTS: Shortcut[] = [
  { key: 'r', label: 'Refresh' },
  { key: 'q', label: 'Quit' },
];

function basicShortcutsFor(view: NavigationView | undefined): Shortcut[] {
  return view?.kind === 'queues' || view === undefined
    ? GLOBAL_SHORTCUTS
    : [{ key: 'Esc/h', label: 'Back' }, ...GLOBAL_SHORTCUTS];
}

function jobActionShortcuts(status: JobStatus | undefined): Shortcut[] {
  return [
    ...(status === 'failed' ? [{ key: 'R', label: 'Retry' }] : []),
    ...(status !== 'active' ? [{ key: 'D', label: 'Delete' }] : []),
    ...(status === 'delayed' ? [{ key: 'p', label: 'Promote' }] : []),
  ];
}

function shortcutsFor(view: NavigationView | undefined, status: JobStatus | undefined): Shortcut[] {
  if (view?.kind === 'detail') {
    return [...jobActionShortcuts(status), { key: 'c', label: 'Copy data' }];
  }
  if (view?.kind === 'jobs') {
    return [
      { key: '↑/↓', label: 'Move' },
      { key: '1-5', label: 'Status' },
      { key: 'b/n', label: 'Page' },
      { key: 'Enter', label: 'Detail' },
      { key: '/', label: 'Filter' },
      ...jobActionShortcuts(status),
      { key: 'c', label: 'Duplicate' },
    ];
  }
  return [
    { key: '↑/↓', label: 'Move' },
    { key: 'Enter', label: 'Jobs' },
    { key: 'p', label: 'Pause/resume' },
    { key: 'D', label: 'Drain' },
  ];
}

function ShortcutSection({ shortcuts, color }: { shortcuts: Shortcut[]; color: string }) {
  return (
    <Box flexDirection="column">
      <Box flexWrap="wrap">
        {shortcuts.map((shortcut) => (
          <Box key={shortcut.key} width={24}>
            <Box width={8}>
              <Text inverse color={color}>
                {` ${shortcut.key} `}
              </Text>
            </Box>
            <Text dimColor> {shortcut.label}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function ShortcutLegend({
  view,
  status,
}: {
  view: NavigationView | undefined;
  status: JobStatus | undefined;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <ShortcutSection shortcuts={basicShortcutsFor(view)} color="yellow" />
      <Box marginTop={1}>
        <ShortcutSection shortcuts={shortcutsFor(view, status)} color="cyan" />
      </Box>
    </Box>
  );
}

/**
 * Top title bar: the app name and version (`bull-cli - v0.1.0`), with a
 * bottom rule separating it from the rest of the screen. Ink can't draw a
 * lone bottom border, so it's a single-style box with the other three sides
 * switched off — leaving just the horizontal line under the title.
 */
export function Header({ version, view, status }: HeaderProps) {
  const breadcrumbs =
    view?.kind === 'jobs'
      ? ['Queues', view.queueName]
      : view?.kind === 'detail'
        ? ['Queues', view.queueName, `job #${view.jobId}`]
        : ['Queues'];
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="single" borderTop={false} borderLeft={false} borderRight={false}>
        <Text bold>bull-cli</Text>
        <Text dimColor> - v{version} </Text>
        {breadcrumbs.map((crumb, index) => (
          <Text key={crumb}>
            {index > 0 && <Text dimColor> &gt; </Text>}
            <Text color={index === breadcrumbs.length - 1 ? 'cyan' : undefined}>{crumb}</Text>
          </Text>
        ))}
      </Box>
      <ShortcutLegend view={view} status={status} />
    </Box>
  );
}

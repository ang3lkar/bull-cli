import { Box, Text } from 'ink';
import type { NavigationView } from '../core/store.js';
import type { JobStatus } from '../core/types.js';

export interface HeaderProps {
  /** App version, taken from package.json at startup (e.g. `0.1.0`). */
  version: string;
  view?: NavigationView;
  status?: JobStatus;
  /** Available content width, excluding the app's horizontal padding. */
  width?: number;
}

interface Shortcut {
  key: string;
  label: string;
}

const MAX_CONTEXTUAL_ROWS = 5;

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

function ShortcutCell({
  shortcut,
  color,
  width,
}: {
  shortcut: Shortcut;
  color: string;
  width: number;
}) {
  return (
    <Box width={width}>
      <Box width={8}>
        <Text color={color}>{`<${shortcut.key}>`}</Text>
      </Box>
      <Text dimColor>{shortcut.label}</Text>
    </Box>
  );
}

function shortcutColumns(shortcuts: Shortcut[]): Shortcut[][] {
  return Array.from({ length: Math.ceil(shortcuts.length / MAX_CONTEXTUAL_ROWS) }, (_, index) =>
    shortcuts.slice(index * MAX_CONTEXTUAL_ROWS, (index + 1) * MAX_CONTEXTUAL_ROWS),
  );
}

function ShortcutLegend({
  view,
  status,
  width,
}: {
  view: NavigationView | undefined;
  status: JobStatus | undefined;
  width: number | undefined;
}) {
  const basicWidth = width === undefined ? 22 : Math.min(22, Math.max(18, Math.floor(width / 3)));
  const contextualWidth = 20;
  const contextualColumns = shortcutColumns(shortcutsFor(view, status));

  return (
    <Box flexDirection="row" marginTop={1} width={width}>
      <Box flexDirection="column" width={basicWidth} marginRight={1}>
        {basicShortcutsFor(view).map((shortcut) => (
          <ShortcutCell key={shortcut.key} shortcut={shortcut} color="yellow" width={basicWidth} />
        ))}
      </Box>
      <Box flexDirection="row" flexGrow={1}>
        {contextualColumns.map((column) => (
          <Box key={column[0]?.key} flexDirection="column" width={contextualWidth}>
            {column.map((shortcut) => (
              <ShortcutCell
                key={shortcut.key}
                shortcut={shortcut}
                color="cyan"
                width={contextualWidth}
              />
            ))}
          </Box>
        ))}
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
export function Header({ version, view, status, width }: HeaderProps) {
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
      <ShortcutLegend view={view} status={status} width={width} />
    </Box>
  );
}

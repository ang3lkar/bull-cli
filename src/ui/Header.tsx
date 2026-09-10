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

/**
 * Cap on rows per contextual column — and, because no column can exceed it,
 * the legend's tallest possible height. The legend reserves exactly this many
 * rows in every view (see `ShortcutLegend`).
 */
const MAX_CONTEXTUAL_ROWS = 5;

const GLOBAL_SHORTCUTS: Shortcut[] = [
  { key: 'r', label: 'Refresh' },
  { key: 'q', label: 'Quit' },
];

function basicShortcutsFor(view: NavigationView | undefined): Shortcut[] {
  return view?.kind === 'queues' || view === undefined
    ? GLOBAL_SHORTCUTS
    : [{ key: 'Esc/h', label: 'Back' }, { key: 'H', label: 'Home' }, ...GLOBAL_SHORTCUTS];
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

  // `minHeight`, not `height`: the legend reserves its full height so the
  // breadcrumb and every table below it stay on a fixed row as you navigate
  // (the tallest column is 4 rows in the queue list, 5 in the job list and as
  // few as 1 in job detail), while still being free to grow if a narrow
  // terminal ever wraps a cell rather than clipping it.
  return (
    <Box flexDirection="row" marginTop={1} width={width} minHeight={MAX_CONTEXTUAL_ROWS}>
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
 * Title bar (`bull-cli v0.1.0`) plus the legend, with a rule between them.
 *
 * The title bar is app chrome and deliberately says nothing about where you
 * are — that's the `Breadcrumb`'s job, rendered with the body content a few
 * rows below (see `CONTEXT.md`).
 *
 * Ink can't draw a lone bottom border, so the rule is a single-style box with
 * the other three sides switched off — leaving just the horizontal line.
 */
export function Header({ version, view, status, width }: HeaderProps) {
  return (
    // `flexShrink={0}`: Ink boxes shrink by default, so once the view below is
    // taller than the terminal, Yoga takes the missing rows out of the header —
    // collapsing the title bar until its bottom rule renders on top of the app
    // name. Chrome keeps its height; the job table absorbs the overflow.
    <Box flexDirection="column" marginBottom={1} flexShrink={0}>
      <Box borderStyle="single" borderTop={false} borderLeft={false} borderRight={false}>
        <Text bold>bull-cli</Text>
        <Text dimColor> v{version}</Text>
      </Box>
      <ShortcutLegend view={view} status={status} width={width} />
    </Box>
  );
}

import { Box, Text } from 'ink';
import type { NavigationView } from '../core/store.js';

export interface HeaderProps {
  /** App version, taken from package.json at startup (e.g. `0.1.0`). */
  version: string;
  view?: NavigationView;
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

function shortcutsFor(view: NavigationView | undefined): Shortcut[] {
  if (view?.kind === 'detail') {
    return [
      { key: 'R', label: 'Retry' },
      { key: 'D', label: 'Delete' },
      { key: 'c', label: 'Copy data' },
    ];
  }
  if (view?.kind === 'jobs') {
    return [
      { key: '↑/↓', label: 'Move' },
      { key: '1-5', label: 'Status' },
      { key: 'b/n', label: 'Page' },
      { key: 'Enter', label: 'Detail' },
      { key: '/', label: 'Filter' },
      { key: 'R', label: 'Retry' },
      { key: 'D', label: 'Delete' },
      { key: 'p', label: 'Promote' },
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
            <Text inverse color={color}>
              {` ${shortcut.key} `}
            </Text>
            <Text dimColor> {shortcut.label}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function ShortcutLegend({ view }: { view: NavigationView | undefined }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <ShortcutSection shortcuts={basicShortcutsFor(view)} color="yellow" />
      <Box marginTop={1}>
        <ShortcutSection shortcuts={shortcutsFor(view)} color="cyan" />
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
export function Header({ version, view }: HeaderProps) {
  const viewLabel =
    view?.kind === 'jobs'
      ? `Queue: ${view.queueName}`
      : view?.kind === 'detail'
        ? `Job: ${view.jobId}`
        : 'Queues';
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="single" borderTop={false} borderLeft={false} borderRight={false}>
        <Text bold>bull-cli</Text>
        <Text dimColor> - v{version} </Text>
        <Text color="cyan">{viewLabel}</Text>
      </Box>
      <ShortcutLegend view={view} />
    </Box>
  );
}

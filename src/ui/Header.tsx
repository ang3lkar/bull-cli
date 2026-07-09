import { Box, Text } from 'ink';

export interface HeaderProps {
  /** App version, taken from package.json at startup (e.g. `0.1.0`). */
  version: string;
}

/**
 * Top title bar: the app name and version (`bull-cli - v0.1.0`), with a
 * bottom rule separating it from the rest of the screen. Ink can't draw a
 * lone bottom border, so it's a single-style box with the other three sides
 * switched off — leaving just the horizontal line under the title.
 */
export function Header({ version }: HeaderProps) {
  return (
    <Box
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      marginBottom={1}
    >
      <Text bold>bull-cli</Text>
      <Text dimColor> - v{version}</Text>
    </Box>
  );
}

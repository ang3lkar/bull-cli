import { Text } from 'ink';

export interface SearchBarProps {
  query: string;
  active: boolean;
}

/**
 * Vim-style `/` search line. Three states:
 * - Active (typing): `/ que▌` — the live cursor line.
 * - Inactive but a query is still applied (accepted via Enter — see
 *   `DashboardStore#acceptSearch`): a dimmed `/ que (filtered)` indicator,
 *   so a filtered job list is never silently unexplained on screen.
 * - Inactive with no query: renders nothing.
 */
export function SearchBar({ query, active }: SearchBarProps) {
  if (active) {
    return <Text>/ {query}▌</Text>;
  }
  if (query !== '') {
    return <Text dimColor>/ {query} (filtered)</Text>;
  }
  return null;
}

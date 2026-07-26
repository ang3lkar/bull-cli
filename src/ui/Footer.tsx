import { Box, Text } from 'ink';
import { maskRedisUrl, relativeTime } from '../core/format.js';
import type { Focus, NavigationView } from '../core/store.js';

export interface FooterProps {
  redisUrl: string;
  lastUpdatedAt: number | null;
  now: number;
  hints: string;
}

export interface KeyHintContext {
  searchActive: boolean;
  confirmDrain: boolean;
  confirmDuplicate: boolean;
  confirmDelete?: boolean;
  view?: NavigationView;
  /** @deprecated Retained temporarily for callers outside the stack UI. */
  detailOpen?: boolean;
  /** @deprecated Retained temporarily for callers outside the stack UI. */
  focus?: Focus;
}

/** Separator between shortcuts in the legend line — a small middle dot with hair spacing. */
const HINT_SEP = ' · ';

/**
 * Builds the context-sensitive shortcut legend string for the current UI
 * state, mirroring the dispatch priority order in `useKeymap.ts` (search
 * input capture > drain confirmation > duplicate confirmation > detail
 * modal > focus-specific bindings). Each shortcut is separated by
 * `HINT_SEP`.
 */
export function keyHintsFor(ctx: KeyHintContext): string {
  if (ctx.searchActive) {
    return ['Enter accept', 'Esc clear'].join(HINT_SEP);
  }
  if (ctx.confirmDrain || ctx.confirmDuplicate || ctx.confirmDelete) {
    return ['y confirm', 'n/Esc cancel'].join(HINT_SEP);
  }
  if (ctx.view?.kind === 'detail' || ctx.detailOpen) {
    return ['R retry', 'D delete', 'c copy data', 'Esc/h back', 'q quit'].join(HINT_SEP);
  }
  if (ctx.view?.kind === 'queues' || ctx.focus === 'sidebar') {
    return ['↑/↓ queues', 'Enter jobs', 'p pause/resume', 'D drain', 'r refresh', 'q quit'].join(
      HINT_SEP,
    );
  }
  return [
    '↑/↓ jobs',
    '1-5 status',
    'b/n page',
    'Enter detail',
    'R retry',
    'D delete',
    'p promote',
    'c duplicate',
    '/ search',
    'Esc/h back',
    'q quit',
  ].join(HINT_SEP);
}

/**
 * Two-row footer: a full-width, context-sensitive shortcut legend line on
 * top, and a bottom bar below it with the masked Redis URL (left) and
 * "Last updated: Ns ago" (right).
 */
export function Footer({ redisUrl, lastUpdatedAt, now, hints }: FooterProps) {
  const updated =
    lastUpdatedAt === null
      ? 'Last updated: —'
      : `Last updated: ${relativeTime(lastUpdatedAt, now)}`;

  return (
    <Box flexDirection="column">
      <Text dimColor>{hints}</Text>
      <Box justifyContent="space-between">
        <Text>{maskRedisUrl(redisUrl)}</Text>
        <Text>{updated}</Text>
      </Box>
    </Box>
  );
}

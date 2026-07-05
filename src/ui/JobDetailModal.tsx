import { Box, Text } from 'ink';
import { formatClock } from '../core/format.js';
import type { JobDetail } from '../core/types.js';

export interface JobDetailModalProps {
  detail: JobDetail;
}

/**
 * Caps pretty-printed JSON payloads at this many lines before appending a
 * `… (truncated)` marker — a job's `data`/`opts`/`returnvalue` can in
 * principle be arbitrarily large, and an unbounded render would blow past
 * the terminal height and make the modal unusable.
 */
const MAX_PAYLOAD_LINES = 20;

/**
 * Pretty-prints a value as JSON, truncating past `MAX_PAYLOAD_LINES` lines.
 * `JSON.stringify` returns `undefined` for `undefined` input (not a string),
 * so that's normalized to the literal text `undefined` rather than crashing
 * on `.split`.
 */
function prettyJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  const text = json === undefined ? 'undefined' : json;
  const lines = text.split('\n');
  if (lines.length <= MAX_PAYLOAD_LINES) {
    return text;
  }
  return `${lines.slice(0, MAX_PAYLOAD_LINES).join('\n')}\n… (truncated)`;
}

function timestampOrDash(ms: number | null): string {
  return ms === null ? '—' : formatClock(ms);
}

/**
 * Centered job detail overlay: header, timestamps, attempts, progress, pretty
 * `data`/`opts` JSON, `returnvalue` when present, and `stacktrace` lines when
 * non-empty. Real overlay/centering positioning happens in `App.tsx`
 * (Phase 8) — this component just renders the modal box itself. Loading is
 * the caller's concern: this component always renders a fully-loaded
 * `detail` (the parent only mounts it once `detailLoading` is false).
 */
export function JobDetailModal({ detail }: JobDetailModalProps) {
  const progressLine =
    detail.progress === null ? prettyJson(detail.rawProgress) : `${detail.progress}%`;

  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      <Text bold>
        {detail.name} <Text dimColor>#{detail.id}</Text>
      </Text>
      <Text>Created: {formatClock(detail.timestamps.created)}</Text>
      <Text>Processed: {timestampOrDash(detail.timestamps.processed)}</Text>
      <Text>Finished: {timestampOrDash(detail.timestamps.finished)}</Text>
      <Text>Attempts: {detail.attemptsMade}</Text>
      <Text>Progress: {progressLine}</Text>

      <Text bold>Data</Text>
      <Text>{prettyJson(detail.data)}</Text>

      {detail.returnvalue !== undefined && (
        <Box flexDirection="column">
          <Text bold>Return Value</Text>
          <Text>{prettyJson(detail.returnvalue)}</Text>
        </Box>
      )}

      {detail.stacktrace.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Stacktrace</Text>
          <Text>{detail.stacktrace.join('\n')}</Text>
        </Box>
      )}

      <Text bold>Opts</Text>
      <Text>{prettyJson(detail.opts)}</Text>
    </Box>
  );
}

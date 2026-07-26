import { Box, Text } from 'ink';
import { formatClock } from '../core/format.js';
import type { JobDetail } from '../core/types.js';

export interface JobDetailModalProps {
  detail: JobDetail;
  queueName?: string;
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
 * Width of the label cell in the left column's metadata table — the longest
 * label is `Processed` (9 chars) plus its colon, so 11 leaves a one-space gutter
 * before every value starts at the same column.
 */
const LABEL_WIDTH = 11;

/** A single left-column metadata row with a fixed-width label so values align. */
function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Box width={LABEL_WIDTH}>
        <Text>{label}:</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  );
}

/**
 * Width of the left metadata column — wide enough to fit a full timestamp line
 * (e.g. `Processed: 2026-07-12 23:47:11`) without wrapping.
 */
const LEFT_COLUMN_WIDTH = 34;

/**
 * Two-column job detail overlay. The left column holds compact metadata — the
 * `name #id` header, timestamps, attempts, and progress — at a fixed width; the
 * right column grows to fill the remaining space with the bulky content: pretty
 * `data`/`opts` JSON, `returnvalue` when present, and `stacktrace` lines when
 * non-empty. Real overlay/centering positioning happens in `App.tsx`
 * (Phase 8) — this component just renders the modal box itself. Loading is
 * the caller's concern: this component always renders a fully-loaded
 * `detail` (the parent only mounts it once `detailLoading` is false).
 */
export function JobDetailModal({ detail, queueName }: JobDetailModalProps) {
  const progressLine =
    detail.progress === null ? prettyJson(detail.rawProgress) : `${detail.progress}%`;

  return (
    <Box borderStyle="round" flexDirection="row" paddingX={1}>
      <Box flexDirection="column" width={LEFT_COLUMN_WIDTH} marginRight={2}>
        <Text bold>
          {detail.name} <Text dimColor>#{detail.id}</Text>
        </Text>
        {queueName !== undefined && <MetaRow label="Queue" value={queueName} />}
        <MetaRow label="Created" value={formatClock(detail.timestamps.created)} />
        <MetaRow label="Processed" value={timestampOrDash(detail.timestamps.processed)} />
        <MetaRow label="Finished" value={timestampOrDash(detail.timestamps.finished)} />
        <MetaRow label="Attempts" value={String(detail.attemptsMade)} />
        <MetaRow label="Progress" value={progressLine} />
      </Box>

      <Box flexDirection="column" flexGrow={1}>
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
    </Box>
  );
}

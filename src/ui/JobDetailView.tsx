import { Box, Text } from 'ink';
import {
  attemptsLimit,
  classifyStack,
  formatClock,
  jobTimings,
  type StackLine,
} from '../core/format.js';
import type { JobDetail } from '../core/types.js';

export interface JobDetailViewProps {
  detail: JobDetail;
  queueName?: string;
}

/**
 * Caps pretty-printed JSON payloads at this many lines before appending a
 * `… (truncated)` marker — a job's `data`/`opts`/`returnvalue` can in
 * principle be arbitrarily large, and an unbounded render would blow past
 * the terminal height and make the view unusable.
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
 * label is `Processed at` (12 chars) plus its colon, so 14 leaves a one-space
 * gutter before every value starts at the same column.
 */
const LABEL_WIDTH = 14;

/** A single left-column metadata row with a fixed-width label so values align. */
function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Box width={LABEL_WIDTH} flexShrink={0}>
        <Text>{label}:</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  );
}

/**
 * Badge colour per bullmq state, matching the status tab colours. Completed
 * gets green here (the tab count is grey) so a successful job reads as one.
 */
const STATE_COLORS: Record<string, string> = {
  delayed: 'yellow',
  waiting: 'yellow',
  prioritized: 'yellow',
  'waiting-children': 'yellow',
  active: 'cyan',
  failed: 'red',
  completed: 'green',
};

function StateBadge({ state }: { state: string }) {
  return (
    <Box>
      <Box width={LABEL_WIDTH} flexShrink={0}>
        <Text>State:</Text>
      </Box>
      <Text bold inverse color={STATE_COLORS[state] ?? 'gray'}>
        {` ${state} `}
      </Text>
    </Box>
  );
}

/**
 * One stack trace line: dependency/Node frames are dimmed and the first frame
 * from the user's own code is highlighted, since that's usually where to look.
 */
function StackLineText({ line }: { line: StackLine }) {
  if (line.kind === 'library') {
    return <Text dimColor>{line.text}</Text>;
  }
  if (line.kind === 'origin') {
    return (
      <Text bold color="yellow">
        {line.text}
      </Text>
    );
  }
  return <Text>{line.text}</Text>;
}

/**
 * Width of the left metadata column — wide enough to fit a full timestamp line
 * (e.g. `Processed at: 2026-07-12 23:47:11`) without wrapping.
 */
const LEFT_COLUMN_WIDTH = 34;

/**
 * Two-column job detail view. The left column holds compact metadata — the
 * `Job ID` and `Job Name`, timestamps, attempts, progress, and `opts` JSON — at a fixed width; the
 * right column grows to fill the remaining space with the bulky content: pretty
 * failure reason (failed jobs only), `data` JSON, `returnvalue` when present,
 * and `stacktrace` lines when non-empty, with the first frame from the user's
 * own code highlighted. Real overlay/centering positioning happens in `App.tsx`
 * (Phase 8) — this component just renders the view box itself. Loading is
 * the caller's concern: this component always renders a fully-loaded
 * `detail` (the parent only mounts it once `detailLoading` is false).
 */
export function JobDetailView({ detail, queueName }: JobDetailViewProps) {
  const progressLine =
    detail.progress === null ? prettyJson(detail.rawProgress) : `${detail.progress}%`;
  const timings = jobTimings(detail.timestamps);

  return (
    <Box borderStyle="round" flexDirection="row" paddingX={1}>
      <Box flexDirection="column" width={LEFT_COLUMN_WIDTH} flexShrink={0} marginRight={2}>
        <MetaRow label="Job ID" value={detail.id} />
        <MetaRow label="Job Name" value={detail.name} />
        <StateBadge state={detail.state} />
        {queueName !== undefined && <MetaRow label="Queue" value={queueName} />}
        <MetaRow label="Created at" value={formatClock(detail.timestamps.created)} />
        <MetaRow label="Processed at" value={timestampOrDash(detail.timestamps.processed)} />
        <MetaRow label="Finished at" value={timestampOrDash(detail.timestamps.finished)} />
        {timings.waited !== null && <MetaRow label="Waited" value={timings.waited} />}
        {timings.ran !== null && <MetaRow label="Ran" value={timings.ran} />}
        <MetaRow
          label="Attempts"
          value={`${detail.attemptsMade} / ${attemptsLimit(detail.opts)}`}
        />
        <MetaRow label="Progress" value={progressLine} />

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Opts</Text>
          <Text>{prettyJson(detail.opts)}</Text>
        </Box>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        {detail.failedReason !== null && (
          <Box marginBottom={1}>
            <Text bold color="red">
              ✖ {detail.failedReason}
            </Text>
          </Box>
        )}

        <Text bold>Data</Text>
        <Text>{prettyJson(detail.data)}</Text>

        {detail.returnvalue !== undefined && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Return Value</Text>
            <Text>{prettyJson(detail.returnvalue)}</Text>
          </Box>
        )}

        {detail.stacktrace.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Stacktrace</Text>
            {classifyStack(detail.stacktrace).map((line, index) => (
              // Lines have no identity beyond their position; the list is
              // rebuilt whole on every render, never reordered.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              <StackLineText key={index} line={line} />
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}

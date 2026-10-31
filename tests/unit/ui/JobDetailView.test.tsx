import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { formatClock } from '../../../src/core/format.js';
import type { JobDetail } from '../../../src/core/types.js';
import { JobDetailView } from '../../../src/ui/JobDetailView.js';

const NOW = 1_700_000_000_000;

function baseDetail(overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 'job-1',
    name: 'sendEmail',
    attemptsMade: 2,
    timestamp: NOW,
    progress: 50,
    data: { to: 'a@b.com', subject: 'hi' },
    returnvalue: undefined,
    stacktrace: [],
    opts: { attempts: 3 },
    timestamps: { created: NOW, processed: null, finished: null },
    rawProgress: 50,
    state: 'active',
    failedReason: null,
    ...overrides,
  };
}

describe('JobDetailView', () => {
  it('shows the pretty-printed data payload as JSON', () => {
    const { lastFrame } = render(<JobDetailView detail={baseDetail()} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('"to": "a@b.com"');
    expect(frame).toContain('"subject": "hi"');
  });

  it('shows returnvalue when present', () => {
    const { lastFrame } = render(
      <JobDetailView detail={baseDetail({ returnvalue: { ok: true } })} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Return Value');
    expect(frame).toContain('"ok": true');
  });

  it('omits the Return Value section when returnvalue is absent', () => {
    const { lastFrame } = render(<JobDetailView detail={baseDetail({ returnvalue: undefined })} />);
    expect(lastFrame()).not.toContain('Return Value');
  });

  it('shows stacktrace lines for failed jobs', () => {
    const { lastFrame } = render(
      <JobDetailView
        detail={baseDetail({
          stacktrace: ['Error: boom', '    at worker.js:12:5'],
        })}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Stacktrace');
    expect(frame).toContain('Error: boom');
    expect(frame).toContain('at worker.js:12:5');
  });

  it('omits the Stacktrace section when there is none', () => {
    const { lastFrame } = render(<JobDetailView detail={baseDetail({ stacktrace: [] })} />);
    expect(lastFrame()).not.toContain('Stacktrace');
  });

  it('renders — for absent processed/finished timestamps and the formatted clock for created', () => {
    const { lastFrame } = render(
      <JobDetailView
        detail={baseDetail({ timestamps: { created: NOW, processed: null, finished: null } })}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain(formatClock(NOW));
    expect(frame).toContain('—');
  });

  it('labels date fields with an "at" suffix and keeps Opts in the left column', () => {
    const { lastFrame } = render(<JobDetailView detail={baseDetail({ opts: { delay: 500 } })} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Created at:');
    expect(frame).toContain('Processed at:');
    expect(frame).toContain('Finished at:');
    const optsLine = frame.split('\n').find((line) => line.includes('Opts')) ?? '';
    const dataLine = frame.split('\n').find((line) => line.includes('Data')) ?? '';
    expect(optsLine.indexOf('Opts')).toBeLessThan(dataLine.indexOf('Data'));
  });

  it('renders present processed/finished timestamps via formatClock', () => {
    const processed = NOW + 1000;
    const finished = NOW + 2000;
    const { lastFrame } = render(
      <JobDetailView detail={baseDetail({ timestamps: { created: NOW, processed, finished } })} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain(formatClock(processed));
    expect(frame).toContain(formatClock(finished));
  });

  it('shows a numeric progress percentage', () => {
    const { lastFrame } = render(<JobDetailView detail={baseDetail({ progress: 75 })} />);
    expect(lastFrame()).toContain('75%');
  });

  it('pretty-prints rawProgress when progress is non-numeric', () => {
    const { lastFrame } = render(
      <JobDetailView detail={baseDetail({ progress: null, rawProgress: { step: 2, total: 5 } })} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('"step": 2');
    expect(frame).toContain('"total": 5');
  });

  it('shows a truncation marker for a huge data payload', () => {
    const bigArray = Array.from({ length: 100 }, (_, i) => `line-${i}`);
    const { lastFrame } = render(<JobDetailView detail={baseDetail({ data: bigArray })} />);
    expect(lastFrame()).toContain('… (truncated)');
  });

  it('does not show a truncation marker for a small payload', () => {
    const { lastFrame } = render(<JobDetailView detail={baseDetail({ data: { small: true } })} />);
    expect(lastFrame()).not.toContain('truncated');
  });

  it('shows attempts and job id/name header', () => {
    const { lastFrame } = render(<JobDetailView detail={baseDetail()} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('sendEmail');
    expect(frame).toContain('job-1');
    expect(frame).toContain('2');
  });

  it('pretty-prints opts as JSON', () => {
    const { lastFrame } = render(<JobDetailView detail={baseDetail({ opts: { delay: 500 } })} />);
    expect(lastFrame()).toContain('"delay": 500');
  });

  it('shows the job state as a badge', () => {
    const { lastFrame } = render(<JobDetailView detail={baseDetail({ state: 'failed' })} />);
    expect(lastFrame()).toContain(' failed ');
  });

  it('shows an unrecognised state too', () => {
    const { lastFrame } = render(
      <JobDetailView detail={baseDetail({ state: 'waiting-children' })} />,
    );
    expect(lastFrame()).toContain('waiting-children');
  });

  it('shows the failure reason when the job failed', () => {
    const { lastFrame } = render(
      <JobDetailView detail={baseDetail({ failedReason: 'connection reset' })} />,
    );
    expect(lastFrame()).toContain('✖ connection reset');
  });

  it('omits the failure reason when there is none', () => {
    const { lastFrame } = render(<JobDetailView detail={baseDetail()} />);
    expect(lastFrame()).not.toContain('✖');
  });

  it('shows attempts made out of the attempts limit', () => {
    const { lastFrame } = render(<JobDetailView detail={baseDetail()} />);
    expect(lastFrame()).toContain('2 / 3');
  });

  it('shows how long the job waited and ran', () => {
    const { lastFrame } = render(
      <JobDetailView
        detail={baseDetail({
          timestamps: { created: NOW, processed: NOW + 2100, finished: NOW + 2440 },
        })}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/Waited:\s+2\.1s/);
    expect(frame).toMatch(/Ran:\s+340ms/);
  });

  it('omits timings for a job that has not started', () => {
    const { lastFrame } = render(<JobDetailView detail={baseDetail()} />);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Waited:');
    expect(frame).not.toContain('Ran:');
  });

  it('renders every stack trace line, library frames included', () => {
    const { lastFrame } = render(
      <JobDetailView
        detail={baseDetail({
          stacktrace: [
            'Error: boom\n    at handler (/app/src/w.ts:1:1)\n    at x (/app/node_modules/y.js:1:1)\n    at z (/app/src/z.ts:2:2)',
          ],
        })}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Error: boom');
    expect(frame).toContain('at handler (/app/src/w.ts:1:1)');
    expect(frame).toContain('at x (/app/node_modules/y.js:1:1)');
    expect(frame).toContain('at z (/app/src/z.ts:2:2)');
  });
});

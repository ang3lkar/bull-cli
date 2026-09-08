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
});

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { formatClock } from '../../../src/core/format.js';
import type { JobSummary } from '../../../src/core/types.js';
import { JobTable } from '../../../src/ui/JobTable.js';

const NOW = 1_700_000_000_000;

const jobs: JobSummary[] = [
  { id: 'job-1', name: 'sendEmail', attemptsMade: 1, timestamp: NOW, progress: 42 },
  { id: 'job-2', name: 'sendSms', attemptsMade: 0, timestamp: NOW - 60_000, progress: null },
];

describe('JobTable', () => {
  it('shows column headers', () => {
    const { lastFrame } = render(
      <JobTable
        jobs={jobs}
        selectedJobId={null}
        page={0}
        pageCount={1}
        focused={false}
        now={NOW}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ID');
    expect(frame).toContain('Name');
    expect(frame).toContain('Attempts');
    expect(frame).toContain('Timestamp');
    expect(frame).toContain('Progress');
  });

  it('renders row values: id, name, attempts, clock timestamp, numeric progress, and — for null progress', () => {
    const { lastFrame } = render(
      <JobTable
        jobs={jobs}
        selectedJobId={null}
        page={0}
        pageCount={1}
        focused={false}
        now={NOW}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('job-1');
    expect(frame).toContain('sendEmail');
    expect(frame).toContain('sendSms');
    expect(frame).toContain(formatClock(NOW));
    expect(frame).toContain('42%');
    expect(frame).toContain('—');
  });

  it('shows the 1-based Page N of M indicator', () => {
    const { lastFrame } = render(
      <JobTable
        jobs={jobs}
        selectedJobId={null}
        page={1}
        pageCount={5}
        focused={false}
        now={NOW}
      />,
    );
    expect(lastFrame()).toContain('Page 2 of 5');
  });

  it('shows a subtle "No jobs" line when the list is empty', () => {
    const { lastFrame } = render(
      <JobTable jobs={[]} selectedJobId={null} page={0} pageCount={1} focused={false} now={NOW} />,
    );
    expect(lastFrame()).toContain('No jobs');
  });

  it('marks the selected row with the focused marker when focused', () => {
    const { lastFrame } = render(
      <JobTable
        jobs={jobs}
        selectedJobId="job-2"
        page={0}
        pageCount={1}
        focused={true}
        now={NOW}
      />,
    );
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const selectedLine = lines.find((l) => l.includes('job-2'));
    expect(selectedLine).toContain('❯');
  });

  it('renders a different highlight when selected but unfocused', () => {
    const focused = render(
      <JobTable
        jobs={jobs}
        selectedJobId="job-2"
        page={0}
        pageCount={1}
        focused={true}
        now={NOW}
      />,
    );
    const unfocused = render(
      <JobTable
        jobs={jobs}
        selectedJobId="job-2"
        page={0}
        pageCount={1}
        focused={false}
        now={NOW}
      />,
    );
    expect(focused.lastFrame()).not.toBe(unfocused.lastFrame());
    const unfocusedLines = (unfocused.lastFrame() ?? '').split('\n');
    const selectedLine = unfocusedLines.find((l) => l.includes('job-2'));
    expect(selectedLine).not.toContain('❯');
  });

  it('truncates a long id/name with an ellipsis', () => {
    const longJobs: JobSummary[] = [
      {
        id: 'a-very-long-job-identifier-that-overflows',
        name: 'aVeryLongJobNameThatOverflowsTheColumn',
        attemptsMade: 3,
        timestamp: NOW,
        progress: 10,
      },
    ];
    const { lastFrame } = render(
      <JobTable
        jobs={longJobs}
        selectedJobId={null}
        page={0}
        pageCount={1}
        focused={false}
        now={NOW}
      />,
    );
    expect(lastFrame()).toContain('…');
  });
});

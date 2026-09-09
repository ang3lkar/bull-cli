import { Box } from 'ink';
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
  it('keeps the column header when the terminal is too short for every row', () => {
    // Overflow lands on this table (the header is `flexShrink={0}`), so the
    // table has to give up a job row rather than the labels that explain the
    // rows still on screen.
    const many: JobSummary[] = Array.from({ length: 20 }, (_, index) => ({
      id: `job-${index}`,
      name: 'sendEmail',
      attemptsMade: 0,
      timestamp: NOW,
      progress: null,
    }));
    const { lastFrame } = render(
      <Box flexDirection="column" height={6}>
        <JobTable jobs={many} selectedJobId={null} page={0} pageCount={2} status="active" />
      </Box>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('CreatedAt');
    expect(frame).toContain('Attempts');
  });

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
    expect(frame).toContain('CreatedAt');
    expect(frame).toContain('State');
  });

  it('renders row values: id, name, state, attempts, and created time', () => {
    const { lastFrame } = render(
      <JobTable jobs={jobs} selectedJobId={null} page={0} pageCount={1} status="active" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('job-1');
    expect(frame).toContain('sendEmail');
    expect(frame).toContain('sendSms');
    expect(frame).toContain(formatClock(NOW));
    expect(frame).toContain('active');
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

  it('shows an empty state without pagination when the status has no jobs', () => {
    const { lastFrame } = render(
      <JobTable
        jobs={[]}
        status="delayed"
        counts={{ active: 2, waiting: 3, completed: 0, failed: 1, delayed: 0 }}
        selectedJobId={null}
        page={0}
        pageCount={1}
      />,
    );
    expect(lastFrame()).toContain('◌ No delayed jobs');
    expect(lastFrame()).toContain('This queue has no jobs in this status.');
    expect(lastFrame()).toContain('Try 2 Waiting · 3 Active · 4 Failed');
    expect(lastFrame()).not.toContain('Page');
  });

  it('shows a loading line rather than the empty state while the page is still being fetched', () => {
    const { lastFrame } = render(
      <JobTable
        jobs={[]}
        status="failed"
        counts={{ active: 0, waiting: 0, completed: 0, failed: 1, delayed: 0 }}
        selectedJobId={null}
        page={0}
        pageCount={1}
        loading
      />,
    );
    const frame = lastFrame() ?? '';
    // An empty list under `loading` means "not fetched yet"; claiming the
    // status is empty would contradict the count of 1 for it.
    expect(frame).toContain('Loading failed jobs…');
    expect(frame).not.toContain('◌ No failed jobs');
    // The column header stays, as it does for every other state.
    expect(frame).toContain('ID');
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

  it('always marks the selected row because this is a single-focus view', () => {
    const result = render(
      <JobTable jobs={jobs} selectedJobId="job-2" page={0} pageCount={1} focused={false} />,
    );
    const selectedLine = (result.lastFrame() ?? '')
      .split('\n')
      .find((line) => line.includes('job-2'));
    expect(selectedLine).toContain('❯');
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

  it('stretches every table row to an 80-column terminal', () => {
    const { lastFrame } = render(
      <JobTable
        jobs={[
          {
            id: 'a-very-long-job-identifier-that-overflows',
            name: 'aVeryLongJobNameThatOverflowsTheColumn',
            attemptsMade: 3,
            timestamp: NOW,
            progress: null,
          },
        ]}
        status="failed"
        selectedJobId="a-very-long-job-identifier-that-overflows"
        page={0}
        pageCount={1}
        width={80}
      />,
    );
    const longestRow = Math.max(
      ...(lastFrame() ?? '')
        .split('\n')
        .filter((line) => !line.includes('Page'))
        .map((line) => line.length),
    );
    expect(longestRow).toBe(80);
  });
});

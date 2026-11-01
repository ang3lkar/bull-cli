import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { SchedulerSummary } from '../../../src/core/types.js';
import { SchedulerTable } from '../../../src/ui/SchedulerTable.js';

const NOW = 1_700_000_000_000;

function scheduler(overrides: Partial<SchedulerSummary> = {}): SchedulerSummary {
  return {
    key: 'daily-digest',
    name: 'send-digest',
    pattern: '0 9 * * *',
    every: null,
    tz: 'Europe/Athens',
    next: NOW + 120_000,
    iterationCount: 3,
    limit: null,
    ...overrides,
  };
}

describe('SchedulerTable', () => {
  it('renders the column headers', () => {
    const frame =
      render(
        <SchedulerTable schedulers={[scheduler()]} selectedKey={null} page={0} pageCount={1} />,
      ).lastFrame() ?? '';
    for (const label of ['Key', 'Name', 'Schedule', 'TZ', 'Next run', 'Iterations']) {
      expect(frame).toContain(label);
    }
  });

  it('renders a cron scheduler row', () => {
    const frame =
      render(
        <SchedulerTable
          schedulers={[scheduler()]}
          selectedKey={null}
          page={0}
          pageCount={1}
          now={NOW}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('daily-digest');
    expect(frame).toContain('send-digest');
    expect(frame).toContain('0 9 * * *');
    expect(frame).toContain('Europe/Athens');
    expect(frame).toContain('in 2m');
  });

  it('renders an every scheduler with a limit and no tz or next run', () => {
    const frame =
      render(
        <SchedulerTable
          schedulers={[
            scheduler({
              key: 'sync',
              pattern: null,
              every: 300_000,
              tz: null,
              next: null,
              iterationCount: 2,
              limit: 10,
            }),
          ]}
          selectedKey={null}
          page={0}
          pageCount={1}
          now={NOW}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('every 5m');
    expect(frame).toContain('2/10');
    expect(frame.match(/—/g)?.length).toBe(2);
  });

  it('marks overdue schedulers', () => {
    const frame =
      render(
        <SchedulerTable
          schedulers={[scheduler({ next: NOW - 1000 })]}
          selectedKey={null}
          page={0}
          pageCount={1}
          now={NOW}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('overdue');
  });

  it('marks the selected row', () => {
    const frame =
      render(
        <SchedulerTable
          schedulers={[scheduler({ key: 'a' }), scheduler({ key: 'b' })]}
          selectedKey="b"
          page={0}
          pageCount={1}
        />,
      ).lastFrame() ?? '';
    const lines = frame.split('\n');
    expect(lines.find((line) => line.includes('❯'))).toContain('b');
    expect(lines.filter((line) => line.includes('❯'))).toHaveLength(1);
  });

  it('truncates long keys and sizes the key column to the width', () => {
    const long = 'k'.repeat(80);
    const frame =
      render(
        <SchedulerTable
          schedulers={[scheduler({ key: long })]}
          selectedKey={null}
          page={0}
          pageCount={1}
          width={110}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('…');
    expect(frame).not.toContain(long);
  });

  it('shows the page position', () => {
    const frame =
      render(
        <SchedulerTable schedulers={[scheduler()]} selectedKey={null} page={1} pageCount={3} />,
      ).lastFrame() ?? '';
    expect(frame).toContain('Page 2 of 3');
  });

  it('shows the empty state', () => {
    const frame =
      render(
        <SchedulerTable schedulers={[]} selectedKey={null} page={0} pageCount={1} />,
      ).lastFrame() ?? '';
    expect(frame).toContain('No job schedulers');
  });

  it('shows a loading message instead of the empty state while fetching', () => {
    const frame =
      render(
        <SchedulerTable schedulers={[]} selectedKey={null} page={0} pageCount={1} loading />,
      ).lastFrame() ?? '';
    expect(frame).toContain('Loading job schedulers');
    expect(frame).not.toContain('No job schedulers');
  });
});

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { formatClock } from '../../../src/core/format.js';
import type { SchedulerDetail } from '../../../src/core/types.js';
import { SchedulerDetailView } from '../../../src/ui/SchedulerDetailView.js';

const NOW = 1_700_000_000_000;

function detail(overrides: Partial<SchedulerDetail> = {}): SchedulerDetail {
  return {
    key: 'daily-digest',
    name: 'send-digest',
    pattern: '0 9 * * *',
    every: null,
    tz: 'Europe/Athens',
    next: NOW + 120_000,
    iterationCount: 3,
    limit: 24,
    startDate: NOW - 86_400_000,
    endDate: null,
    offset: 250,
    template: { data: { audience: 'all' }, opts: { attempts: 3 } },
    nextJobId: 'repeat:daily-digest:1',
    ...overrides,
  };
}

describe('SchedulerDetailView', () => {
  it('shows the schedule metadata', () => {
    const frame =
      render(<SchedulerDetailView detail={detail()} queueName="emailQ" now={NOW} />).lastFrame() ??
      '';
    expect(frame).toContain('daily-digest');
    expect(frame).toContain('send-digest');
    expect(frame).toContain('emailQ');
    expect(frame).toContain('0 9 * * *');
    expect(frame).toContain('Europe/Athens');
    expect(frame).toContain(formatClock(NOW + 120_000));
    expect(frame).toContain('in 2m');
    expect(frame).toContain(formatClock(NOW - 86_400_000));
    expect(frame).toContain('3/24');
    expect(frame).toContain('250ms');
    expect(frame).toContain('repeat:daily-digest:1');
    expect(frame).toContain('Enter opens the next job');
  });

  it('shows the template data and opts as JSON', () => {
    const frame = render(<SchedulerDetailView detail={detail()} now={NOW} />).lastFrame() ?? '';
    expect(frame).toContain('Template data');
    expect(frame).toContain('"audience": "all"');
    expect(frame).toContain('Template opts');
    expect(frame).toContain('"attempts": 3');
    expect(frame).not.toContain('Queue:');
  });

  it('uses dashes and no hint for missing optional fields', () => {
    const frame =
      render(
        <SchedulerDetailView
          detail={detail({
            pattern: null,
            every: 30_000,
            tz: null,
            next: null,
            limit: null,
            startDate: null,
            offset: null,
            nextJobId: null,
            template: { data: undefined, opts: undefined },
          })}
          now={NOW}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('every 30s');
    expect(frame).not.toContain('Enter opens the next job');
    expect(frame).toMatch(/Next job:[^\n]*\n[^\n]*—/);
    expect(frame).toMatch(/Offset:\s+—/);
    expect(frame).toContain('undefined');
  });
});

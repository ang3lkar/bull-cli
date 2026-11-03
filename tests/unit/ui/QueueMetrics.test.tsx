import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { QueueMetrics } from '../../../src/ui/QueueMetrics.js';

const totals = { delayed: 3, waiting: 12, active: 1, failed: 4, completed: 230 };
const rates = { completedPerMin: 42.4, failedPerMin: 0.5 };

const frame = (el: React.ReactElement) => render(el).lastFrame() ?? '';

describe('QueueMetrics', () => {
  it('shows the totals of every status and labelled rates when there is room', () => {
    // ink-testing-library's stdout is 100 columns, so the tail of the 101-column line is cut.
    const out = frame(<QueueMetrics totals={totals} throughput={rates} width={120} />);
    expect(out).toContain(
      'Total 3 delayed · 12 waiting · 1 active · 4 failed · 230 done   Throughput 42/min done · 0.5/min',
    );
  });

  it('shows — for throughput until a rate exists', () => {
    const out = frame(<QueueMetrics totals={totals} throughput={null} width={120} />);
    expect(out).toContain('Throughput — done · — failed');
  });

  it('drops the Throughput label first in a 100-column terminal', () => {
    const out = frame(<QueueMetrics totals={totals} throughput={rates} width={98} />);
    expect(out).toBe(
      'Total 3 delayed · 12 waiting · 1 active · 4 failed · 230 done   42/min done · 0.5/min failed',
    );
  });

  it('abbreviates in an 80-column terminal, keeping both rates', () => {
    const out = frame(<QueueMetrics totals={totals} throughput={rates} width={78} />);
    expect(out).toBe(
      'All 3 dly · 12 wait · 1 act · 4 fail · 230 done   42/min done · 0.5/min fail',
    );
  });

  it('drops the prefix and separators when large counts overflow 80 columns', () => {
    const big = { delayed: 1200, waiting: 34_000, active: 120, failed: 5600, completed: 1_250_000 };
    const out = frame(<QueueMetrics totals={big} throughput={rates} width={78} />);
    expect(out).toBe(
      '1200 dly 34000 wait 120 act 5600 fail 1250000 done   42/min done 0.5/min fail',
    );
  });

  it('truncates to one line only when even the compact layout does not fit', () => {
    const out = frame(
      <Box width={30}>
        <QueueMetrics totals={totals} throughput={rates} width={30} />
      </Box>,
    );
    expect(out.split('\n')).toHaveLength(1);
    expect(out.startsWith('3 dly 12 wait')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });

  it('uses the full layout when the width is unknown', () => {
    const out = frame(<QueueMetrics totals={totals} throughput={null} />);
    expect(out.startsWith('Total 3 delayed')).toBe(true);
  });
});

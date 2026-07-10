import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { formatCount, Tabs } from '../../../src/ui/Tabs.js';

describe('Tabs', () => {
  describe('rendering', () => {
    it('shows all five tab names', () => {
      const { lastFrame } = render(<Tabs active="active" />);
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Active');
      expect(frame).toContain('Waiting');
      expect(frame).toContain('Completed');
      expect(frame).toContain('Failed');
      expect(frame).toContain('Delayed');
    });

    it('renders blank count slots when counts is omitted', () => {
      const { lastFrame } = render(<Tabs active="waiting" />);
      const frame = lastFrame() ?? '';
      // No parentheses with counts inside (decimal or abbreviated)
      expect(frame).not.toMatch(/\(\d+\)/);
      expect(frame).not.toMatch(/\(~\d+[km]\)/);
    });

    it('renders blank count slots when counts is explicitly null', () => {
      const { lastFrame } = render(<Tabs active="waiting" counts={null} />);
      const frame = lastFrame() ?? '';
      // No parentheses with counts inside
      expect(frame).not.toMatch(/\(\d+\)/);
      expect(frame).not.toMatch(/\(~\d+[km]\)/);
    });

    it('renders per-tab job counts with tight parens and right-aligned 6-char slot', () => {
      const { lastFrame } = render(
        <Tabs
          active="active"
          counts={{ active: 3, waiting: 15, completed: 0, failed: 1, delayed: 2 }}
        />,
      );
      const frame = lastFrame() ?? '';
      // The entire "(count)" group is right-aligned in a 6-char slot.
      // For active tab with count 3: "[Active]" + "   (3)" (3 spaces + 3 chars) = "[Active]   (3)"
      expect(frame).toContain('[Active]   (3)');
      // For inactive tabs: marker + count slot
      // " Waiting " (9 chars) + "  (15)" (2 spaces from padStart + 4-char count) = " Waiting   (15)"
      expect(frame).toContain(' Waiting   (15)');
      // " Completed " (11 chars) + "   (0)" (3 spaces from padStart + 3-char count) = " Completed    (0)"
      expect(frame).toContain(' Completed    (0)');
      // " Failed " (8 chars) + "   (1)" = " Failed    (1)"
      expect(frame).toContain(' Failed    (1)');
      // " Delayed " (9 chars) + "   (2)" = " Delayed    (2)"
      expect(frame).toContain(' Delayed    (2)');
    });

    it('handles abbreviated counts with tilde for short forms and no tilde for 4-char mantissa', () => {
      const { lastFrame } = render(
        <Tabs
          active="active"
          counts={{ active: 1000, waiting: 99999, completed: 100000, failed: 1000000, delayed: 100000000 }}
        />,
      );
      const frame = lastFrame() ?? '';
      // Count 1000 → "(~1k)" (5 chars) padStart(6) = " (~1k)"
      expect(frame).toContain('[Active] (~1k)');
      // Count 99999 → "(~99k)" (6 chars) fills slot exactly with 0 spaces
      expect(frame).toContain(' Waiting (~99k)');
      // Count 100000 → "(100k)" (6 chars, no tilde) fills slot exactly
      // " Completed " (11 chars) + "(100k)" (6 chars, no padding) = " Completed (100k)"
      expect(frame).toContain(' Completed (100k)');
      // Count 1000000 → "(~1m)" (5 chars) padStart(6) = " (~1m)"
      expect(frame).toContain(' Failed  (~1m)');
      // Count 100000000 → "(100m)" (6 chars, no tilde) fills slot exactly
      // " Delayed " (9 chars) + "(100m)" (6 chars, no padding) = " Delayed (100m)"
      expect(frame).toContain(' Delayed (100m)');
    });
  });

  describe('bracket highlight', () => {
    it('highlights the active tab (bracketed) and leaves others plain', () => {
      const { lastFrame } = render(<Tabs active="active" />);
      const frame = lastFrame() ?? '';
      expect(frame).toContain('[Active]');
      expect(frame).not.toContain('[Waiting]');
      expect(frame).not.toContain('[Completed]');
      expect(frame).not.toContain('[Failed]');
      expect(frame).not.toContain('[Delayed]');
    });

    it('moves the highlight when a different tab is active', () => {
      const { lastFrame } = render(<Tabs active="failed" />);
      const frame = lastFrame() ?? '';
      expect(frame).toContain('[Failed]');
      expect(frame).not.toContain('[Active]');
    });
  });

  describe('positional stability', () => {
    it('maintains label column positions when counts transition from null to loaded', () => {
      const { lastFrame: frameWithoutCounts } = render(<Tabs active="active" counts={null} />);
      const { lastFrame: frameWithCounts } = render(
        <Tabs
          active="active"
          counts={{ active: 3, waiting: 15, completed: 0, failed: 1, delayed: 2 }}
        />,
      );

      const frameA = frameWithoutCounts() ?? '';
      const frameB = frameWithCounts() ?? '';

      // Label positions should be identical (compare indexOf for each label).
      // This is the key assertion: regardless of whether counts have loaded,
      // the labels appear at the same column positions.
      const labels = ['Active', 'Waiting', 'Completed', 'Failed', 'Delayed'];
      for (const label of labels) {
        expect(frameA.indexOf(label)).toBe(frameB.indexOf(label));
      }
    });

    it('maintains label positions with single-digit vs 4-digit counts', () => {
      const { lastFrame: frameSmall } = render(
        <Tabs
          active="active"
          counts={{ active: 3, waiting: 5, completed: 1, failed: 9, delayed: 2 }}
        />,
      );
      const { lastFrame: frameLarge } = render(
        <Tabs
          active="active"
          counts={{ active: 9999, waiting: 8888, completed: 7777, failed: 6666, delayed: 5555 }}
        />,
      );

      const frameA = frameSmall() ?? '';
      const frameB = frameLarge() ?? '';

      // Both frames should have the same length (all counts are right-aligned in 6-char slots)
      expect(frameA.length).toBe(frameB.length);

      // Label positions should be identical
      const labels = ['Active', 'Waiting', 'Completed', 'Failed', 'Delayed'];
      for (const label of labels) {
        expect(frameA.indexOf(label)).toBe(frameB.indexOf(label));
      }
    });

    it('maintains label positions when active tab changes', () => {
      const counts = { active: 100, waiting: 200, completed: 300, failed: 400, delayed: 500 };
      const { lastFrame: frameActive } = render(<Tabs active="active" counts={counts} />);
      const { lastFrame: frameWaiting } = render(<Tabs active="waiting" counts={counts} />);

      const frameA = frameActive() ?? '';
      const frameB = frameWaiting() ?? '';

      // Both frames should have the same length
      expect(frameA.length).toBe(frameB.length);

      // Label positions should be identical
      const labels = ['Active', 'Waiting', 'Completed', 'Failed', 'Delayed'];
      for (const label of labels) {
        expect(frameA.indexOf(label)).toBe(frameB.indexOf(label));
      }
    });

    it('maintains label positions across tilde-drop boundary (99999 vs 100000)', () => {
      const { lastFrame: frameWithTilde } = render(
        <Tabs
          active="active"
          counts={{ active: 99999, waiting: 99999, completed: 99999, failed: 99999, delayed: 99999 }}
        />,
      );
      const { lastFrame: frameWithoutTilde } = render(
        <Tabs
          active="active"
          counts={{ active: 100000, waiting: 100000, completed: 100000, failed: 100000, delayed: 100000 }}
        />,
      );

      const frameA = frameWithTilde() ?? '';
      const frameB = frameWithoutTilde() ?? '';

      // Both frames should have the same length (both have 6-char right-aligned count slots)
      expect(frameA.length).toBe(frameB.length);

      // Label positions should be identical even though tilde is dropped
      // (~99k → 100k)
      const labels = ['Active', 'Waiting', 'Completed', 'Failed', 'Delayed'];
      for (const label of labels) {
        expect(frameA.indexOf(label)).toBe(frameB.indexOf(label));
      }
    });

    it('maintains label positions when slot is completely full (999999 → (999k))', () => {
      const { lastFrame: framePartiallyFull } = render(
        <Tabs
          active="active"
          counts={{ active: 4000, waiting: 5000, completed: 6000, failed: 7000, delayed: 8000 }}
        />,
      );
      const { lastFrame: frameCompletelyFull } = render(
        <Tabs
          active="active"
          counts={{ active: 999999, waiting: 999999, completed: 999999, failed: 999999, delayed: 999999 }}
        />,
      );

      const frameA = framePartiallyFull() ?? '';
      const frameB = frameCompletelyFull() ?? '';

      // Both frames should have the same length (6-char slots)
      expect(frameA.length).toBe(frameB.length);

      // Label positions should be identical even when slot is completely filled with no leading spaces
      const labels = ['Active', 'Waiting', 'Completed', 'Failed', 'Delayed'];
      for (const label of labels) {
        expect(frameA.indexOf(label)).toBe(frameB.indexOf(label));
      }
    });
  });

  describe('formatCount helper', () => {
    it('returns exact decimal string for counts under 1000', () => {
      expect(formatCount(0)).toBe('0');
      expect(formatCount(1)).toBe('1');
      expect(formatCount(9)).toBe('9');
      expect(formatCount(99)).toBe('99');
      expect(formatCount(999)).toBe('999');
    });

    it('formats 1000-99999 with ~Nk suffix (result ≤ 3 chars)', () => {
      expect(formatCount(1000)).toBe('~1k');
      expect(formatCount(4000)).toBe('~4k');
      expect(formatCount(99999)).toBe('~99k');
    });

    it('drops tilde for 4-char mantissa (100k, 999k, 100m)', () => {
      expect(formatCount(100000)).toBe('100k');
      expect(formatCount(999999)).toBe('999k');
      expect(formatCount(100000000)).toBe('100m');
    });

    it('formats 1000000+ with ~Nm suffix when result ≤ 3 chars', () => {
      expect(formatCount(1000000)).toBe('~1m');
      expect(formatCount(99000000)).toBe('~99m');
    });

    it('always returns at most 4 characters', () => {
      const testValues = [0, 9, 99, 999, 1000, 4000, 99999, 100000, 999999, 1000000, 99000000, 100000000, 999999999];
      for (const val of testValues) {
        expect(formatCount(val).length).toBeLessThanOrEqual(4);
      }
    });
  });
});

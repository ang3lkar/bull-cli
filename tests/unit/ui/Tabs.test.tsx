import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Tabs } from '../../../src/ui/Tabs.js';

describe('Tabs', () => {
  it('shows all five tab names', () => {
    const { lastFrame } = render(<Tabs active="active" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Active');
    expect(frame).toContain('Waiting');
    expect(frame).toContain('Completed');
    expect(frame).toContain('Failed');
    expect(frame).toContain('Delayed');
  });

  it('renders bare labels (no counts) when counts is omitted', () => {
    const { lastFrame } = render(<Tabs active="waiting" />);
    expect(lastFrame()).not.toMatch(/\(\d+\)/);
  });

  it('renders bare labels (no counts) when counts is explicitly null', () => {
    const { lastFrame } = render(<Tabs active="waiting" counts={null} />);
    expect(lastFrame()).not.toMatch(/\(\d+\)/);
  });

  it('renders per-tab job counts alongside tab names when passed as a prop', () => {
    const { lastFrame } = render(
      <Tabs
        active="active"
        counts={{ active: 3, waiting: 15, completed: 0, failed: 1, delayed: 2 }}
      />,
    );
    const frame = lastFrame() ?? '';
    // The active tab is bracketed, so its count must be checked outside the
    // brackets; inactive tabs render as a clean `Label (count)` substring.
    expect(frame).toContain('[Active] (3)');
    expect(frame).toContain('Waiting (15)');
    expect(frame).toContain('Completed (0)');
    expect(frame).toContain('Failed (1)');
    expect(frame).toContain('Delayed (2)');
  });

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

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

  it('does NOT render job counts alongside tab names', () => {
    const { lastFrame } = render(<Tabs active="waiting" />);
    expect(lastFrame()).not.toMatch(/\(\d+\)/);
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

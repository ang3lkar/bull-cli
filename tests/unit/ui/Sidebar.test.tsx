import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Sidebar } from '../../../src/ui/Sidebar.js';

describe('Sidebar', () => {
  const queues = [
    { name: 'emailQ', isPaused: false },
    { name: 'reportQ', isPaused: false },
    { name: 'smsQ', isPaused: true },
  ];

  it('lists all queue names', () => {
    const { lastFrame } = render(<Sidebar queues={queues} selectedName={null} focused={false} />);
    const frame = lastFrame();
    expect(frame).toContain('emailQ');
    expect(frame).toContain('reportQ');
    expect(frame).toContain('smsQ');
  });

  it('shows the pause indicator only on paused queues', () => {
    const { lastFrame } = render(<Sidebar queues={queues} selectedName={null} focused={false} />);
    const lines = (lastFrame() ?? '').split('\n');
    const smsLine = lines.find((l) => l.includes('smsQ'));
    const emailLine = lines.find((l) => l.includes('emailQ'));
    expect(smsLine).toContain('(paused)');
    expect(emailLine).not.toContain('(paused)');
  });

  it('marks the selected row with the focused marker when focused', () => {
    const { lastFrame } = render(<Sidebar queues={queues} selectedName="reportQ" focused={true} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('❯');
    const lines = frame.split('\n');
    const selectedLine = lines.find((l) => l.includes('reportQ'));
    expect(selectedLine).toContain('❯');
  });

  it('marks the selected row differently when NOT focused (highlight style differs by focus)', () => {
    const focused = render(<Sidebar queues={queues} selectedName="reportQ" focused={true} />);
    const unfocused = render(<Sidebar queues={queues} selectedName="reportQ" focused={false} />);

    expect(focused.lastFrame()).not.toBe(unfocused.lastFrame());
    expect(unfocused.lastFrame()).not.toContain('❯');
  });

  it('renders a subtle empty message when there are no queues', () => {
    const { lastFrame } = render(<Sidebar queues={[]} selectedName={null} focused={false} />);
    expect(lastFrame()).toContain('No queues');
  });
});

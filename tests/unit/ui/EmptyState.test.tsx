import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { EmptyState } from '../../../src/ui/EmptyState.js';

describe('EmptyState', () => {
  it('shows the exact spec message for a plain URL', () => {
    const { lastFrame } = render(<EmptyState url="redis://localhost:6379" />);
    expect(lastFrame()).toContain('No BullMQ queues found on redis://localhost:6379');
  });

  it('masks the password when the URL carries credentials', () => {
    const { lastFrame } = render(<EmptyState url="redis://user:secret@host:6379" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('No BullMQ queues found on redis://user:****@host:6379');
    expect(frame).not.toContain('secret');
  });
});

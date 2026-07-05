import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Toast } from '../../../src/ui/Toast.js';

describe('Toast', () => {
  it('renders each toast message', () => {
    const { lastFrame } = render(
      <Toast
        toasts={[
          { id: 1, message: 'Job retried' },
          { id: 2, message: 'Delete failed: job is active' },
        ]}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Job retried');
    expect(frame).toContain('Delete failed: job is active');
  });

  it('renders nothing when there are no toasts', () => {
    const { lastFrame } = render(<Toast toasts={[]} />);
    expect(lastFrame()).toBe('');
  });
});

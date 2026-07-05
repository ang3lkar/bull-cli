import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { ErrorScreen } from '../../../src/ui/ErrorScreen.js';

describe('ErrorScreen', () => {
  it('shows the (masked) url and the human message', () => {
    const { lastFrame } = render(
      <ErrorScreen url="redis://user:secret@host:6379" message="Connection refused" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Cannot connect to Redis');
    expect(frame).toContain('redis://user:****@host:6379');
    expect(frame).not.toContain('secret');
    expect(frame).toContain('Connection refused');
  });

  it('shows a hint to check the connection or pass --redis', () => {
    const { lastFrame } = render(
      <ErrorScreen url="redis://localhost:6379" message="ECONNREFUSED" />,
    );
    expect(lastFrame()).toContain('Check the connection or pass --redis');
  });

  it('does not render raw stack trace frames', () => {
    const { lastFrame } = render(
      <ErrorScreen url="redis://localhost:6379" message="ECONNREFUSED" />,
    );
    expect(lastFrame()).not.toMatch(/at .+:\d+:\d+/);
  });
});

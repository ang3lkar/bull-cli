import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Footer } from '../../../src/ui/Footer.js';

describe('Footer', () => {
  it('masks the password in the Redis URL', () => {
    const { lastFrame } = render(<Footer redisUrl="redis://user:secret@host:6379" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('redis://user:****@host:6379');
    expect(frame).not.toContain('secret');
  });

  it('shows the connection and nothing else', () => {
    const { lastFrame } = render(<Footer redisUrl="redis://localhost:6379" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('redis://localhost:6379');
    expect(frame).not.toContain('Last updated');
    expect(frame).not.toContain('Refresh');
    expect(frame).not.toContain('Quit');
  });
});

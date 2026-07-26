import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Footer } from '../../../src/ui/Footer.js';

describe('Footer', () => {
  it('masks the password in the Redis URL', () => {
    const { lastFrame } = render(
      <Footer redisUrl="redis://user:secret@host:6379" lastUpdatedAt={null} now={1000} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('redis://user:****@host:6379');
    expect(frame).not.toContain('secret');
  });

  it('shows the last refresh time without shortcut hints', () => {
    const { lastFrame } = render(
      <Footer redisUrl="redis://localhost:6379" lastUpdatedAt={8000} now={10000} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Last updated: 2s ago');
    expect(frame).not.toContain('Refresh');
    expect(frame).not.toContain('Quit');
  });

  it('shows a placeholder when no refresh has completed', () => {
    const { lastFrame } = render(
      <Footer redisUrl="redis://localhost:6379" lastUpdatedAt={null} now={10000} />,
    );
    expect(lastFrame()).toContain('Last updated: —');
  });
});

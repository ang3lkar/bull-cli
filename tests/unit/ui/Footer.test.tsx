import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Footer } from '../../../src/ui/Footer.js';

describe('Footer', () => {
  it('masks the password in the redis URL (left section)', () => {
    const { lastFrame } = render(
      <Footer redisUrl="redis://user:secret@host:6379" lastUpdatedAt={null} now={1000} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('redis://user:****@host:6379');
    expect(frame).not.toContain('secret');
  });

  it('shows "Last updated: 2s ago" when now - lastUpdatedAt is 2000ms', () => {
    const { lastFrame } = render(
      <Footer redisUrl="redis://localhost:6379" lastUpdatedAt={8000} now={10000} />,
    );
    expect(lastFrame()).toContain('Last updated: 2s ago');
  });

  it('shows a placeholder when lastUpdatedAt is null', () => {
    const { lastFrame } = render(
      <Footer redisUrl="redis://localhost:6379" lastUpdatedAt={null} now={10000} />,
    );
    expect(lastFrame()).toContain('Last updated: —');
  });

  it('shows the key hint reminders on the right', () => {
    const { lastFrame } = render(
      <Footer redisUrl="redis://localhost:6379" lastUpdatedAt={null} now={1000} />,
    );
    expect(lastFrame()).toContain('/ search  R refresh  q quit');
  });
});

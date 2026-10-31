import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Footer } from '../../../src/ui/Footer.js';

describe('Footer', () => {
  it('masks the password in the Redis URL', () => {
    const { lastFrame } = render(<Footer redisUrl="redis://user:secret@host:6379" prefix="bull" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('redis://user:****@host:6379');
    expect(frame).not.toContain('secret');
  });

  it('shows the connection and the prefix, and nothing else', () => {
    const { lastFrame } = render(<Footer redisUrl="redis://localhost:6379" prefix="bull" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('redis://localhost:6379');
    expect(frame).toContain('prefix bull');
    expect(frame).not.toContain('Last updated');
    expect(frame).not.toContain('Refresh');
    expect(frame).not.toContain('Quit');
  });

  it('puts the prefix on the right, after the connection', () => {
    const { lastFrame } = render(<Footer redisUrl="redis://localhost:6379" prefix="myapp" />);
    const line = lastFrame() ?? '';
    expect(line.indexOf('prefix myapp')).toBeGreaterThan(line.indexOf('redis://localhost:6379'));
    expect(line.trimEnd().endsWith('prefix myapp')).toBe(true);
  });
});

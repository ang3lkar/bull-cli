import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Loading } from '../../../src/ui/Loading.js';

describe('Loading', () => {
  it('names the Redis instance being discovered', () => {
    const { lastFrame } = render(<Loading url="redis://localhost:6379" />);
    expect(lastFrame()).toContain('Discovering queues on redis://localhost:6379');
  });

  it('masks the password when the URL carries credentials', () => {
    const { lastFrame } = render(<Loading url="redis://user:secret@host:6379" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Discovering queues on redis://user:****@host:6379');
    expect(frame).not.toContain('secret');
  });
});

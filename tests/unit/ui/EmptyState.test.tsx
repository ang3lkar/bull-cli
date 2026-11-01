import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { EmptyState } from '../../../src/ui/EmptyState.js';

describe('EmptyState', () => {
  it('shows prefix, DB and the hints for a plain URL', () => {
    const { lastFrame } = render(<EmptyState url="redis://localhost:6379" prefix="bull" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('No BullMQ queues found under prefix "bull" in DB 0 on');
    expect(frame).toContain('redis://localhost:6379');
    expect(frame).toContain('--prefix <prefix>');
    expect(frame).toContain('BULLMQ_PREFIX');
    expect(frame).toContain('redis://localhost:6379/1');
    expect(frame).toContain('bull-cli doctor');
  });

  it('derives the DB from the URL and suggests /0 when already on DB 1', () => {
    const { lastFrame } = render(<EmptyState url="redis://localhost:6379/1" prefix="myapp" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('prefix "myapp" in DB 1');
    expect(frame).toContain('e.g. redis://localhost:6379/0');
  });

  it('masks the password everywhere', () => {
    const { lastFrame } = render(
      <EmptyState url="redis://user:secret@host:6379/3" prefix="bull" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('in DB 3');
    expect(frame).toContain('redis://user:****@host:6379/3');
    expect(frame).toContain('redis://user:****@host:6379/1');
    expect(frame).not.toContain('secret');
  });

  it('falls back to DB 0 for an unparseable URL', () => {
    const { lastFrame } = render(<EmptyState url="not a url" prefix="bull" />);
    expect(lastFrame()).toContain('in DB 0 on not a url');
  });

  it('falls back to DB 0 for a non-numeric DB path', () => {
    const { lastFrame } = render(<EmptyState url="redis://localhost:6379/abc" prefix="bull" />);
    expect(lastFrame()).toContain('in DB 0');
  });
});

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Footer, keyHintsFor } from '../../../src/ui/Footer.js';

describe('Footer', () => {
  it('masks the password in the redis URL (left section)', () => {
    const { lastFrame } = render(
      <Footer
        redisUrl="redis://user:secret@host:6379"
        lastUpdatedAt={null}
        now={1000}
        hints="hint"
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('redis://user:****@host:6379');
    expect(frame).not.toContain('secret');
  });

  it('shows "Last updated: 2s ago" when now - lastUpdatedAt is 2000ms', () => {
    const { lastFrame } = render(
      <Footer redisUrl="redis://localhost:6379" lastUpdatedAt={8000} now={10000} hints="hint" />,
    );
    expect(lastFrame()).toContain('Last updated: 2s ago');
  });

  it('shows a placeholder when lastUpdatedAt is null', () => {
    const { lastFrame } = render(
      <Footer redisUrl="redis://localhost:6379" lastUpdatedAt={null} now={10000} hints="hint" />,
    );
    expect(lastFrame()).toContain('Last updated: —');
  });

  it('shows the passed hints string on the legend line above the bottom bar', () => {
    const { lastFrame } = render(
      <Footer
        redisUrl="redis://localhost:6379"
        lastUpdatedAt={null}
        now={1000}
        hints="/ search  R refresh  q quit"
      />,
    );
    expect(lastFrame()).toContain('/ search  R refresh  q quit');
  });
});

describe('keyHintsFor', () => {
  it('search input active: "Enter accept · Esc clear"', () => {
    expect(
      keyHintsFor({
        searchActive: true,
        confirmDrain: false,
        confirmDuplicate: false,
        detailOpen: false,
        focus: 'jobs',
      }),
    ).toBe('Enter accept · Esc clear');
  });

  it('drain confirmation pending: "y confirm · n/Esc cancel"', () => {
    expect(
      keyHintsFor({
        searchActive: false,
        confirmDrain: true,
        confirmDuplicate: false,
        detailOpen: false,
        focus: 'sidebar',
      }),
    ).toBe('y confirm · n/Esc cancel');
  });

  it('duplicate confirmation pending: "y confirm · n/Esc cancel"', () => {
    expect(
      keyHintsFor({
        searchActive: false,
        confirmDrain: false,
        confirmDuplicate: true,
        detailOpen: false,
        focus: 'jobs',
      }),
    ).toBe('y confirm · n/Esc cancel');
  });

  it('detail view shows retry, delete, copy, and back actions', () => {
    expect(
      keyHintsFor({
        searchActive: false,
        confirmDrain: false,
        confirmDuplicate: false,
        detailOpen: true,
        focus: 'jobs',
      }),
    ).toBe('R retry · D delete · c copy data · Esc/h back · q quit');
  });

  it('sidebar focused', () => {
    expect(
      keyHintsFor({
        searchActive: false,
        confirmDrain: false,
        confirmDuplicate: false,
        detailOpen: false,
        focus: 'sidebar',
      }),
    ).toBe('↑/↓ queues · Enter jobs · p pause/resume · D drain · r refresh · q quit');
  });

  it('job list focused', () => {
    expect(
      keyHintsFor({
        searchActive: false,
        confirmDrain: false,
        confirmDuplicate: false,
        detailOpen: false,
        focus: 'jobs',
      }),
    ).toBe(
      '↑/↓ jobs · 1-5 status · b/n page · Enter detail · R retry · D delete · p promote · c duplicate · / search · Esc/h back · q quit',
    );
  });

  it('priority: searchActive wins over detailOpen', () => {
    expect(
      keyHintsFor({
        searchActive: true,
        confirmDrain: false,
        confirmDuplicate: false,
        detailOpen: true,
        focus: 'jobs',
      }),
    ).toBe('Enter accept · Esc clear');
  });

  it('priority: confirmDrain wins over detailOpen', () => {
    expect(
      keyHintsFor({
        searchActive: false,
        confirmDrain: true,
        confirmDuplicate: false,
        detailOpen: true,
        focus: 'jobs',
      }),
    ).toBe('y confirm · n/Esc cancel');
  });

  it('priority: confirmDuplicate wins over detailOpen', () => {
    expect(
      keyHintsFor({
        searchActive: false,
        confirmDrain: false,
        confirmDuplicate: true,
        detailOpen: true,
        focus: 'jobs',
      }),
    ).toBe('y confirm · n/Esc cancel');
  });
});

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Header } from '../../../src/ui/Header.js';

describe('Header', () => {
  it('shows the app name and version', () => {
    const { lastFrame } = render(<Header version="1.2.3" />);
    expect(lastFrame()).toContain('bull-cli v1.2.3');
  });

  it('draws a bottom rule to separate it from the rest of the screen', () => {
    const { lastFrame } = render(<Header version="1.2.3" />);
    // A border-bottom rule (box-drawing horizontals) appears below the title.
    expect(lastFrame()).toMatch(/─{3,}/);
  });

  it('renders the current view shortcuts as a key/action grid', () => {
    const { lastFrame } = render(
      <Header version="1.2.3" view={{ kind: 'jobs', queueName: 'email' }} />,
    );
    expect(lastFrame()).toContain('Quit');
    expect(lastFrame()).toContain('1-5');
    expect(lastFrame()).toContain('Status');
    expect(lastFrame()).toContain('Duplicate');
    expect(lastFrame()).toContain('Refresh');
  });

  it('is app chrome only: never reports where you are', () => {
    // Location lives in the body's `Breadcrumb`, so the title bar must not repeat it.
    const { lastFrame } = render(
      <Header version="1.2.3" view={{ kind: 'detail', queueName: 'emailQ', jobId: '43' }} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('bull-cli v1.2.3');
    expect(frame).not.toContain('emailQ');
    expect(frame).not.toContain('#43');
    expect(frame).not.toContain('Queues');
  });

  it('only lists actions valid for the active job status', () => {
    const delayed = render(
      <Header version="1.2.3" view={{ kind: 'jobs', queueName: 'emailQ' }} status="delayed" />,
    ).lastFrame();
    expect(delayed).toContain('Promote');
    expect(delayed).not.toContain('Retry');

    const failed = render(
      <Header version="1.2.3" view={{ kind: 'jobs', queueName: 'emailQ' }} status="failed" />,
    ).lastFrame();
    expect(failed).toContain('Retry');
    expect(failed).not.toContain('Promote');
  });

  it('is the same height in every view, so nothing below it moves', () => {
    // The legend's tallest column varies by view (4 rows in queues, 5 in jobs,
    // as few as 1 in detail). Reserving its full height keeps the breadcrumb and
    // every table below it on a fixed row as you navigate.
    const views = [
      { kind: 'queues' },
      { kind: 'jobs', queueName: 'emailQ' },
      { kind: 'detail', queueName: 'emailQ', jobId: '43' },
    ] as const;
    const statuses = ['delayed', 'active', 'failed'] as const;

    const heights = new Set(
      views.flatMap((view) =>
        statuses.map((status) => {
          const { lastFrame } = render(
            <Header version="1.2.3" view={view} status={status} width={78} />,
          );
          return (lastFrame() ?? '').split('\n').length;
        }),
      ),
    );
    expect(heights.size).toBe(1);
  });

  it('keeps basic and contextual shortcuts in compact columns at 80 characters', () => {
    const { lastFrame } = render(
      <Header
        version="1.2.3"
        view={{ kind: 'jobs', queueName: 'emailQ' }}
        status="delayed"
        width={78}
      />,
    );
    const shortcutRows = (lastFrame() ?? '').split('\n').filter((line) => line.includes('<'));
    expect(shortcutRows.length).toBeLessThanOrEqual(10);
    expect(lastFrame()).toContain('<r>');
    expect(lastFrame()).toContain('<↑/↓>');
  });
});

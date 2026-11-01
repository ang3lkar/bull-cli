import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Breadcrumb } from '../../../src/ui/Breadcrumb.js';

describe('Breadcrumb', () => {
  it('shows a single crumb at the top of the stack', () => {
    const { lastFrame } = render(<Breadcrumb view={{ kind: 'queues' }} />);
    expect(lastFrame()).toContain('Queues');
    expect(lastFrame()).not.toContain('>');
  });

  it('grows an entry as you descend into a queue', () => {
    const { lastFrame } = render(<Breadcrumb view={{ kind: 'jobs', queueName: 'emailQ' }} />);
    expect(lastFrame()).toContain('Queues > emailQ');
  });

  it('grows a job entry in the detail view', () => {
    const { lastFrame } = render(
      <Breadcrumb view={{ kind: 'detail', queueName: 'emailQ', jobId: '43' }} />,
    );
    expect(lastFrame()).toContain('Queues > emailQ > job #43');
  });

  it('puts the status tab between the queue and the job in the detail view', () => {
    const { lastFrame } = render(
      <Breadcrumb view={{ kind: 'detail', queueName: 'reportQ', jobId: '6' }} status="failed" />,
    );
    expect(lastFrame()).toContain('Queues > reportQ > failed > job #6');
  });

  it('leaves the status out of the job list view, where the tabs already show it', () => {
    const { lastFrame } = render(
      <Breadcrumb view={{ kind: 'jobs', queueName: 'reportQ' }} status="failed" />,
    );
    expect(lastFrame()).toContain('Queues > reportQ');
    expect(lastFrame()).not.toContain('failed');
  });

  it('renders a queue literally named "Queues" without collapsing the crumbs', () => {
    const { lastFrame } = render(<Breadcrumb view={{ kind: 'jobs', queueName: 'Queues' }} />);
    expect(lastFrame()).toContain('Queues > Queues');
  });

  it('adds a schedulers crumb in the job list when that tab is selected', () => {
    const { lastFrame } = render(
      <Breadcrumb view={{ kind: 'jobs', queueName: 'emailQ' }} status="schedulers" />,
    );
    expect(lastFrame()).toContain('Queues > emailQ > schedulers');
  });

  it('shows the scheduler key in the scheduler detail', () => {
    const { lastFrame } = render(
      <Breadcrumb view={{ kind: 'scheduler', queueName: 'emailQ', key: 'daily-digest' }} />,
    );
    expect(lastFrame()).toContain('Queues > emailQ > schedulers > daily-digest');
  });

  it('continues the trail with the job opened from a scheduler', () => {
    const { lastFrame } = render(
      <Breadcrumb
        view={{ kind: 'detail', queueName: 'emailQ', jobId: 'repeat:daily-digest:99' }}
        status="schedulers"
        schedulerKey="daily-digest"
      />,
    );
    expect(lastFrame()).toContain(
      'Queues > emailQ > schedulers > daily-digest > job #repeat:daily-digest:99',
    );
  });
});

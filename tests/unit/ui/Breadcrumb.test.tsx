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

  it('renders a queue literally named "Queues" without collapsing the crumbs', () => {
    const { lastFrame } = render(<Breadcrumb view={{ kind: 'jobs', queueName: 'Queues' }} />);
    expect(lastFrame()).toContain('Queues > Queues');
  });
});

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { ConfirmPrompt } from '../../../src/ui/ConfirmPrompt.js';

describe('ConfirmPrompt', () => {
  it('shows the confirmation message', () => {
    const message = 'Drain queue "emailQ"? This removes all waiting and delayed jobs. [y/N]';
    const { lastFrame } = render(<ConfirmPrompt message={message} />);
    expect(lastFrame()).toContain(message);
  });
});

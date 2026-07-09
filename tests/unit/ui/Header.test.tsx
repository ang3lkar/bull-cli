import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Header } from '../../../src/ui/Header.js';

describe('Header', () => {
  it('shows the app name and version', () => {
    const { lastFrame } = render(<Header version="1.2.3" />);
    expect(lastFrame()).toContain('bull-cli - v1.2.3');
  });

  it('draws a bottom rule to separate it from the rest of the screen', () => {
    const { lastFrame } = render(<Header version="1.2.3" />);
    // A border-bottom rule (box-drawing horizontals) appears below the title.
    expect(lastFrame()).toMatch(/─{3,}/);
  });
});

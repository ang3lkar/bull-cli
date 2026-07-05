import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { SearchBar } from '../../../src/ui/SearchBar.js';

describe('SearchBar', () => {
  it('shows "/ que" style input when active', () => {
    const { lastFrame } = render(<SearchBar query="que" active={true} />);
    expect(lastFrame()).toContain('/ que');
  });

  it('renders nothing when not active and the query is empty', () => {
    const { lastFrame } = render(<SearchBar query="" active={false} />);
    expect(lastFrame()).toBe('');
  });

  it('shows a dimmed "(filtered)" indicator when inactive but a query is still applied', () => {
    const { lastFrame } = render(<SearchBar query="que" active={false} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/ que');
    expect(frame).toContain('(filtered)');
  });
});

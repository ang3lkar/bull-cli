import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

describe('ink sanity', () => {
  it('renders a Text component', () => {
    const { lastFrame } = render(<Text>hello</Text>);
    expect(lastFrame()).toBe('hello');
  });
});

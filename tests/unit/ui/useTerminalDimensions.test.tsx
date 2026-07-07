import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalDimensions } from '../../../src/ui/hooks/useTerminalDimensions.js';

/** Renders the hook's current output as text so assertions can read `lastFrame()`. */
function Probe() {
  const { columns, rows } = useTerminalDimensions();
  return (
    <Text>
      cols={columns ?? 'none'} rows={rows ?? 'none'}
    </Text>
  );
}

// Effects (where the hook's `stdout.on('resize', ...)` subscription happens)
// are scheduled via the timer-based scheduler, not a microtask — fake timers
// + advancing by 0ms flushes them, matching app.test.tsx's `flush()`.
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTerminalDimensions', () => {
  it('reads the initial size from stdout (ink-testing-library: columns=100, rows=undefined)', async () => {
    const { lastFrame } = render(<Probe />);
    await flush();
    expect(lastFrame()).toBe('cols=100 rows=none');
  });

  it('updates when stdout emits a resize event', async () => {
    const { lastFrame, stdout } = render(<Probe />);
    await flush();
    expect(lastFrame()).toBe('cols=100 rows=none');

    Object.defineProperty(stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(stdout, 'rows', { value: 24, configurable: true });
    stdout.emit('resize');
    await flush();

    expect(lastFrame()).toBe('cols=80 rows=24');
  });

  it('removes its resize listener when the component using the hook unmounts', async () => {
    const { stdout, rerender } = render(<Probe />);
    await flush();
    const withHook = stdout.listenerCount('resize');

    // ink-testing-library's `render()` flushes effects synchronously, so
    // there's no way to observe a "before mount" count on this same stdout
    // instance. Instead, swap `Probe` out for a plain component on the same
    // instance via `rerender` — that unmounts the hook (running its effect
    // cleanup) while Ink's own internal `resize` subscription on this
    // instance is untouched, isolating exactly what our hook added.
    rerender(<Text>plain</Text>);
    await flush();

    expect(stdout.listenerCount('resize')).toBe(withHook - 1);
  });
});

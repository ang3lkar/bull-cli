import { describe, expect, it, vi } from 'vitest';
import { createAltScreen } from '../../src/terminal.js';

const ENTER = '\x1b[?1049h';
const LEAVE = '\x1b[?1049l';

describe('createAltScreen', () => {
  it('enter() writes the enter-alt-screen escape once; a second enter() is a no-op', () => {
    const write = vi.fn();
    const altScreen = createAltScreen({ write });

    altScreen.enter();
    altScreen.enter();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(ENTER);
  });

  it('leave() before any enter() writes nothing', () => {
    const write = vi.fn();
    const altScreen = createAltScreen({ write });

    altScreen.leave();

    expect(write).not.toHaveBeenCalled();
  });

  it('enter() then leave() writes both escapes in order; a second leave() is a no-op', () => {
    const write = vi.fn();
    const altScreen = createAltScreen({ write });

    altScreen.enter();
    altScreen.leave();
    altScreen.leave();

    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(1, ENTER);
    expect(write).toHaveBeenNthCalledWith(2, LEAVE);
  });

  it('is re-entrant: enter -> leave -> enter emits the enter escape again', () => {
    const write = vi.fn();
    const altScreen = createAltScreen({ write });

    altScreen.enter();
    altScreen.leave();
    altScreen.enter();

    expect(write).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenNthCalledWith(3, ENTER);
  });
});

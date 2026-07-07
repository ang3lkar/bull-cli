import { useStdout } from 'ink';
import { useEffect, useState } from 'react';

export interface TerminalDimensions {
  columns: number | undefined;
  rows: number | undefined;
}

/**
 * Guarded read of `stdout.columns`/`rows`: ink-testing-library's fake stdout
 * has no `rows` at all (and Node's real stdout reports `0` when it isn't a
 * TTY), so falsy values are normalized to `undefined` rather than surfacing
 * as `0` — a `0` would make `<Box height={0}>` render nothing at all.
 */
function readDimensions(stdout: NodeJS.WriteStream): TerminalDimensions {
  return { columns: stdout.columns || undefined, rows: stdout.rows || undefined };
}

/**
 * Tracks the terminal's current size so `App` can stretch its root `<Box>`
 * to fill the screen. Ink itself re-renders internally on `stdout`'s
 * `'resize'` event (repainting/clearing as needed) but never feeds the new
 * dimensions into the component tree's layout — without this hook the root
 * `<Box>` has no `height` and stays sized to its content forever, even in
 * the real fullscreen (alt-screen) terminal.
 *
 * Returns raw, possibly-`undefined` values on purpose — no baked-in
 * fallback (e.g. 80×24). In tests, ink-testing-library's fake stdout has no
 * `rows`, so `App` passes `height={undefined}` (Yoga auto-sizes, same as
 * today) and every existing frame assertion is unaffected. A fallback would
 * pad every unit-test frame with blank lines for no coverage gain.
 */
export function useTerminalDimensions(): TerminalDimensions {
  const { stdout } = useStdout();
  const [dimensions, setDimensions] = useState<TerminalDimensions>(() => readDimensions(stdout));

  useEffect(() => {
    const onResize = () => setDimensions(readDimensions(stdout));
    onResize(); // re-sync in case the size changed between first render and this effect
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return dimensions;
}

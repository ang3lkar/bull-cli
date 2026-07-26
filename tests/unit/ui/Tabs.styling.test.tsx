import { describe, expect, it, vi } from 'vitest';

// Kept separate from Tabs.test.tsx: FORCE_COLOR must be stubbed before chalk's
// color-support level is resolved, which requires a dynamic import here — a
// static import of Tabs/ink-testing-library anywhere else in this file (or a
// merge into a file that already has one) fixes that level at 0 first and
// silently breaks color detection.
describe('Tabs styling', () => {
  it("highlights the active tab's marker and count slot together, with no reset between them", async () => {
    vi.stubEnv('FORCE_COLOR', '3');
    const { render } = await import('ink-testing-library');
    const { Tabs } = await import('../../../src/ui/Tabs.js');
    const { lastFrame } = render(
      <Tabs
        active="active"
        counts={{ active: 123, waiting: 456, completed: 789, failed: 100, delayed: 200 }}
      />,
    );
    const frame = lastFrame() ?? '';
    vi.unstubAllEnvs();

    // Inverse+bold spans the whole active cell (marker + count slot) as one
    // styled run, with no reset code in between — proves they share one <Text>.
    const ansiEscape = '\u001b';
    const activeCellMatch = frame.match(
      new RegExp(
        `${ansiEscape}\\[7m${ansiEscape}\\[1m(\\[Active\\].*?\\))${ansiEscape}\\[22m${ansiEscape}\\[27m`,
      ),
    );
    expect(activeCellMatch).not.toBeNull();
    expect(activeCellMatch?.[1]).not.toContain(ansiEscape);

    // Inactive cells carry no inverse (7m) style codes.
    // After the active cell closes, " Failed" appears without \x1b[7m prefix.
    expect(frame).toContain('\x1b[22m\x1b[27m |  Failed');
  });
});

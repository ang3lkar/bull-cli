import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { vi } from 'vitest';
import type { ConnectionOpts } from '../../src/config.js';
import type { DashboardSnapshot, DashboardStore } from '../../src/core/store.js';
import { App } from '../../src/ui/App.js';
import { createApp, type WiredApp } from '../../src/wiring.js';

/**
 * Dedicated Redis logical DB for the full-app e2e suite (discovery=1,
 * jobs=2, actions=3, registry=13, redis=14, sanity=15 are all taken by
 * `tests/integration/*`).
 */
export const E2E_DB = 4;

export const REDIS_URL = 'redis://localhost:6379/4';
/** Nothing listens here — used by the "Redis unreachable" error-screen scenario. */
export const UNREACHABLE_REDIS_URL = 'redis://localhost:9999/4';

/** Plain `ConnectionOpts` for seeding/verification `Queue`s against the same DB the app under test uses. */
export const CONNECTION: ConnectionOpts = { host: 'localhost', port: 6379, db: E2E_DB };

/**
 * Key byte sequences for `stdin.write(...)`. Built with `String.fromCharCode`
 * (rather than a ``-style escape literal) so the control byte can't be
 * accidentally mangled by an editing pass over this source file. Arrow keys
 * aren't needed by any Phase 9 scenario — every list auto-selects its
 * first/newest row on load.
 */
export const KEY = {
  tab: '\t',
  enter: '\r',
  esc: String.fromCharCode(27),
  /**
   * Standard CSI arrow-down sequence (`ESC [ B`, per
   * `ink/build/parse-keypress.js`'s `'[B': 'down'` mapping) — needed by the
   * colon-named-queue-recovery scenario to move the sidebar selection off
   * an un-openable queue without calling `store.selectQueue` directly.
   */
  down: `${String.fromCharCode(27)}[B`,
} as const;

type RenderResult = ReturnType<typeof render>;

export interface MountedApp {
  app: WiredApp;
  instance: RenderResult;
  stdin: RenderResult['stdin'];
  lastFrame: RenderResult['lastFrame'];
}

/**
 * Builds a real `createApp(redisUrl, prefix)`, calls `start()` (connect +
 * first refresh + polling), and renders `<App/>` around its store — the full
 * production wiring, exactly as `cli.tsx` does it. `prefix` defaults to
 * `'bull'` (test scaffolding, unlike the app's own internal call chain,
 * where the prefix is always required explicitly).
 */
export async function mountApp(redisUrl: string, prefix = 'bull'): Promise<MountedApp> {
  const app = createApp(redisUrl, prefix);
  await app.start();
  const onQuit = vi.fn();
  const instance = render(createElement(App, { store: app.store, onQuit }));
  return { app, instance, stdin: instance.stdin, lastFrame: instance.lastFrame };
}

/**
 * Unmounts the ink instance and stops the app (polling timer, cached
 * `Queue`s, ioredis connection). Both steps are required to avoid hanging
 * the process: `unmount()` alone leaves `App`'s internal 1s "Last updated"
 * clock (`useNow`) running via `setInterval`; `app.stop()` alone leaves the
 * store's poll timer and Redis connection alive. Safe to call with
 * `undefined` (e.g. a scenario that never finished mounting).
 */
export async function unmountApp(mounted: MountedApp | undefined): Promise<void> {
  if (!mounted) {
    return;
  }
  mounted.instance.unmount();
  await mounted.app.stop();
}

/**
 * Polls `lastFrame()` (real timers — no `vi.useFakeTimers` here, per the
 * plan's Phase 9 notes: the real store polls every 3s against real Redis)
 * until `predicate` matches, returning the matching frame. Throws (via
 * `vi.waitUntil`) if `timeoutMs` elapses first.
 */
export async function waitForFrame(
  lastFrame: () => string | undefined,
  predicate: (frame: string) => boolean,
  timeoutMs = 7000,
): Promise<string> {
  let frame = '';
  await vi.waitUntil(
    () => {
      frame = lastFrame() ?? '';
      return predicate(frame);
    },
    { timeout: timeoutMs, interval: 50 },
  );
  return frame;
}

/**
 * Writes a key to stdin, then polls the resulting frame until `predicate`
 * matches. Chaining `stdin.write` calls back-to-back without waiting for the
 * UI to actually re-render the previous keystroke risks `useKeymap` dispatching
 * the next key against a stale `DashboardSnapshot` closure (real timers mean
 * React's re-render isn't synchronous with the input event) — waiting for a
 * visible effect of each keystroke before sending the next one avoids that.
 */
export async function pressAndWaitForFrame(
  mounted: MountedApp,
  key: string,
  predicate: (frame: string) => boolean,
  timeoutMs = 7000,
): Promise<string> {
  mounted.stdin.write(key);
  return waitForFrame(mounted.lastFrame, predicate, timeoutMs);
}

/** Polls `store.getSnapshot()` directly until `predicate` matches — useful for state that isn't easily expressed as a frame substring. */
export async function waitForSnapshot(
  store: DashboardStore,
  predicate: (snapshot: DashboardSnapshot) => boolean,
  timeoutMs = 7000,
): Promise<DashboardSnapshot> {
  let snapshot = store.getSnapshot();
  await vi.waitUntil(
    () => {
      snapshot = store.getSnapshot();
      return predicate(snapshot);
    },
    { timeout: timeoutMs, interval: 50 },
  );
  return snapshot;
}
